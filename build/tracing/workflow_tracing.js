'use strict'

const {
  trace,
  context,
  SpanStatusCode,
  SpanKind,
} = require('@opentelemetry/api')
const { flatten } = require('flat')

function setupWorkflowTracing({ logPrefix = '[Tracing]', debug = false } = {}) {
  const tracer = trace.getTracer('n8n-instrumentation', '1.0.0')

  try {
    // Import n8n core modules
    const { WorkflowExecute } = require('n8n-core')

    if (WorkflowExecute?.prototype?.__n8nOtelPatched) {
      if (debug) {
        console.log(`${logPrefix}: Workflow tracing already patched`)
      }
      return
    }

    /**
     * Attach tracing via ExecutionLifecycleHooks to avoid wrapping node execution.
     * This reduces side effects while keeping spans for all nodes.
     */
    const originalSetupExecution = WorkflowExecute.prototype.setupExecution
    WorkflowExecute.prototype.setupExecution = function () {
      const setupResult = originalSetupExecution.apply(this, arguments)
      try {
        const hooks = setupResult?.hooks || this?.additionalData?.hooks
        if (hooks && !hooks.__n8nOtelHooked) {
          attachTracingHooks(hooks, { tracer, logPrefix, debug })
          hooks.__n8nOtelHooked = true
        }
        if (hooks) {
          this.__n8nOtelHooks = hooks
        }
      } catch (error) {
        console.warn(`${logPrefix}: Failed to attach lifecycle hooks: ${error.message}`)
      }
      return setupResult
    }

    const originalRunNode = WorkflowExecute.prototype.runNode
    if (!WorkflowExecute.prototype.__n8nOtelRunNodePatched) {
      WorkflowExecute.prototype.runNode = function () {
        try {
          const hooks = this.__n8nOtelHooks || this?.additionalData?.hooks
          const nodeSpanStore = hooks?.__n8nOtelNodeSpanStore
          if (!nodeSpanStore) {
            return originalRunNode.apply(this, arguments)
          }

          const executionIndex = (this?.additionalData?.currentNodeExecutionIndex ?? 0) - 1
          const nodeSpan = nodeSpanStore.get(executionIndex)
          if (!nodeSpan) {
            return originalRunNode.apply(this, arguments)
          }

          const executionData = arguments?.[1]
          const nodeType = executionData?.node?.type ?? ''
          if (isAgentOrToolNode(nodeType)) {
            return originalRunNode.apply(this, arguments)
          }

          const spanContext = trace.setSpan(context.active(), nodeSpan)
          return context.with(spanContext, () => originalRunNode.apply(this, arguments))
        } catch (error) {
          return originalRunNode.apply(this, arguments)
        }
      }
      WorkflowExecute.prototype.__n8nOtelRunNodePatched = true
    }

    WorkflowExecute.prototype.__n8nOtelPatched = true
    console.log(`${logPrefix}: Workflow tracing patched successfully`)
  } catch (e) {
    console.error('Failed to set up n8n OpenTelemetry workflow tracing:', e)
  }
}

function safeFlatten(value) {
  try {
    return flatten(value ?? {}, { delimiter: '.' })
  } catch (error) {
    return null
  }
}

function safeStringify(value, { maxStringLength = 20000 } = {}) {
  if (value === undefined) return undefined

  try {
    const seen = new WeakSet()
    const json = JSON.stringify(value, (key, val) => {
      if (typeof val === 'bigint') return val.toString()
      if (typeof val === 'function') return '[Function]'
      if (typeof val === 'symbol') return val.toString()
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack }
      }
      if (val instanceof Date) return val.toISOString()
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[Circular]'
        seen.add(val)
      }
      if (typeof val === 'string' && val.length > maxStringLength) {
        return `${val.slice(0, maxStringLength)}…`
      }
      return val
    })

    if (json === undefined) return undefined
    return json
  } catch (error) {
    return String(value)
  }
}

function attachTracingHooks(hooks, { tracer, logPrefix, debug }) {
  const nodeSpanStore = new Map()
  const nodeSpanByName = new Map()
  const syntheticAgentSpans = new Set()
  let workflowSpan = null
  hooks.__n8nOtelNodeSpanStore = nodeSpanStore
  hooks.__n8nOtelNodeSpanByName = nodeSpanByName
  hooks.__n8nOtelSyntheticAgentSpans = syntheticAgentSpans

  const startWorkflowSpan = (workflow) => {
    if (workflowSpan) return
    const wfData = workflow || {}
    const workflowId = wfData?.id ?? ''
    const workflowName = wfData?.name ?? ''
    const workflowAttributes = {
      'n8n.workflow.id': workflowId,
      'n8n.workflow.name': workflowName,
      ...flatten(wfData?.settings ?? {}, {
        delimiter: '.',
        transformKey: (key) => `n8n.workflow.settings.${key}`,
      }),
    }

    workflowSpan = tracer.startSpan('n8n.workflow.execute', {
      attributes: workflowAttributes,
      kind: SpanKind.INTERNAL,
    })
    hooks.__n8nOtelWorkflowSpan = workflowSpan

    if (debug) {
      console.debug(`${logPrefix}: starting n8n workflow via hooks:`, workflowName)
    }
  }

  hooks.addHandler('workflowExecuteBefore', function (workflow) {
    startWorkflowSpan(workflow)
  })

  hooks.addHandler('workflowExecuteResume', function (workflow) {
    startWorkflowSpan(workflow)
  })

  hooks.addHandler('workflowExecuteAfter', function (fullRunData) {
    if (!workflowSpan) return
    try {
      const err = fullRunData?.data?.resultData?.error
      if (err) {
        workflowSpan.recordException(err)
        workflowSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: String(err.message || err),
        })
      }
    } catch (error) {
      // best effort
    } finally {
      workflowSpan.end()
      workflowSpan = null
      hooks.__n8nOtelWorkflowSpan = null
      for (const span of syntheticAgentSpans) {
        try {
          span.end()
        } catch (error) {
          // best effort
        }
      }
      syntheticAgentSpans.clear()
      nodeSpanByName.clear()
      nodeSpanStore.clear()
    }
  })

  hooks.addHandler('nodeExecuteBefore', function (nodeName, taskStartedData) {
    const node = this?.workflowData?.nodes?.find((item) => item.name === nodeName)
    const nodeType = node?.type ?? 'unknown'
    const nodeAttributes = {
      'n8n.workflow.id': this?.workflowData?.id ?? 'unknown',
      'n8n.execution.id': this?.executionId ?? 'unknown',
      'n8n.node.type': nodeType || 'unknown',
      'n8n.node.name': nodeName ?? 'unknown',
    }

    const flattenedNode = safeFlatten(node)
    if (flattenedNode) {
      for (const [key, value] of Object.entries(flattenedNode)) {
        if (typeof value === 'string' || typeof value === 'number') {
          nodeAttributes[`n8n.node.${key}`] = value
        } else {
          nodeAttributes[`n8n.node.${key}`] = safeStringify(value)
        }
      }
    }

    const existingSpan = nodeSpanByName.get(nodeName)
    const agentParentName = resolveAgentParentName(this, nodeName, taskStartedData)
    let parentSpan = workflowSpan

    if (agentParentName) {
    const agentSpan =
        nodeSpanByName.get(agentParentName) ||
        createSyntheticAgentSpan({
          executionContext: this,
          agentNodeName: agentParentName,
          workflowSpan,
          tracer,
          syntheticAgentSpans,
          nodeSpanByName,
          startTime: taskStartedData?.startTime,
        })
      if (agentSpan) {
        parentSpan = agentSpan
      }
    }

    const parentCtx = parentSpan
      ? trace.setSpan(context.active(), parentSpan)
      : context.active()
    const nodeSpan =
      existingSpan && syntheticAgentSpans.has(existingSpan)
        ? existingSpan
        : tracer.startSpan(
            'n8n.node.execute',
            {
              attributes: nodeAttributes,
              kind: SpanKind.INTERNAL,
              startTime: taskStartedData?.startTime ? taskStartedData.startTime : undefined,
            },
            parentCtx,
          )
    nodeSpanStore.set(taskStartedData?.executionIndex, nodeSpan)
    nodeSpanByName.set(nodeName, nodeSpan)
  })

  hooks.addHandler('nodeExecuteAfter', function (nodeName, taskData) {
    const spanKey = taskData?.executionIndex
    const existingSpan = nodeSpanStore.get(spanKey)
    const fallbackSpan = nodeSpanByName.get(nodeName)
    const nodeSpan =
      existingSpan ||
      fallbackSpan ||
      tracer.startSpan(
        'n8n.node.execute',
        {
          attributes: {
            'n8n.workflow.id': this?.workflowData?.id ?? 'unknown',
            'n8n.execution.id': this?.executionId ?? 'unknown',
            'n8n.node.name': nodeName ?? 'unknown',
          },
          kind: SpanKind.INTERNAL,
        },
        hooks.__n8nOtelWorkflowSpan
          ? trace.setSpan(context.active(), hooks.__n8nOtelWorkflowSpan)
          : context.active(),
      )

    try {
      if (taskData?.error) {
        nodeSpan.recordException(taskData.error)
        nodeSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: String(taskData.error.message || taskData.error),
        })
      }

      const outputJson = extractOutputJson(taskData?.data)
      if (outputJson !== undefined) {
        nodeSpan.setAttribute('n8n.node.output_json', safeStringify(outputJson))
      }
    } catch (error) {
      console.warn('Failed to set node output attributes: ', error)
    } finally {
      nodeSpan.end()
      nodeSpanStore.delete(spanKey)
      if (nodeSpanByName.get(nodeName) === nodeSpan) {
        nodeSpanByName.delete(nodeName)
      }
      if (syntheticAgentSpans.has(nodeSpan)) {
        syntheticAgentSpans.delete(nodeSpan)
      }
    }
  })
}

function extractOutputJson(taskDataConnections) {
  if (!taskDataConnections || typeof taskDataConnections !== 'object') return undefined
  const main = taskDataConnections.main
  if (Array.isArray(main) && Array.isArray(main[0])) {
    return main[0].map((item) => item?.json)
  }
  return taskDataConnections
}

function resolveAgentParentName(context, nodeName, taskStartedData) {
  const workflowData = context?.workflowData
  const sourceParent = taskStartedData?.source?.[0]?.previousNode
  if (sourceParent && isAgentNodeName(workflowData, sourceParent)) {
    return sourceParent
  }

  const connections = workflowData?.connections?.[nodeName]
  if (!connections) return undefined

  const aiConnectionTypes = [
    'ai_languageModel',
    'ai_tool',
    'ai_memory',
    'ai_outputParser',
    'ai_retriever',
    'ai_document',
    'ai_embedding',
    'ai_textSplitter',
    'ai_vectorStore',
    'ai_reranker',
    'ai_chain',
    'ai_agent',
  ]

  for (const connType of aiConnectionTypes) {
    const connectionGroups = connections[connType]
    if (!Array.isArray(connectionGroups)) continue
    for (const group of connectionGroups) {
      if (!Array.isArray(group)) continue
      for (const connection of group) {
        const targetNodeName = connection?.node
        if (targetNodeName && isAgentNodeName(workflowData, targetNodeName)) {
          return targetNodeName
        }
      }
    }
  }

  return undefined
}

function createSyntheticAgentSpan({
  executionContext,
  agentNodeName,
  workflowSpan,
  tracer,
  syntheticAgentSpans,
  nodeSpanByName,
  startTime,
}) {
  if (!agentNodeName) return null
  if (nodeSpanByName.has(agentNodeName)) {
    return nodeSpanByName.get(agentNodeName)
  }

  const agentNode = executionContext?.workflowData?.nodes?.find(
    (item) => item.name === agentNodeName,
  )
  const nodeAttributes = {
    'n8n.workflow.id': executionContext?.workflowData?.id ?? 'unknown',
    'n8n.execution.id': executionContext?.executionId ?? 'unknown',
    'n8n.node.type': agentNode?.type ?? 'unknown',
    'n8n.node.name': agentNodeName ?? 'unknown',
  }

  const parentCtx = workflowSpan
    ? trace.setSpan(context.active(), workflowSpan)
    : context.active()
  const span = tracer.startSpan(
    'n8n.node.execute',
    {
      attributes: nodeAttributes,
      kind: SpanKind.INTERNAL,
      startTime: startTime || undefined,
    },
    parentCtx,
  )

  nodeSpanByName.set(agentNodeName, span)
  syntheticAgentSpans.add(span)
  return span
}

function isAgentOrToolNode(nodeType) {
  if (typeof nodeType !== 'string') return false
  const normalized = nodeType.toLowerCase()
  return normalized.includes('.agent') || normalized.includes('.tool')
}

function isAgentNodeName(workflowData, nodeName) {
  if (!workflowData || !nodeName) return false
  const node = workflowData?.nodes?.find((item) => item.name === nodeName)
  return isAgentNodeType(node?.type)
}

function isAgentNodeType(nodeType) {
  if (typeof nodeType !== 'string') return false
  return nodeType.toLowerCase().includes('.agent')
}

module.exports = { setupWorkflowTracing }
