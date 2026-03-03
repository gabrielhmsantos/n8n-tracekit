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
  const BaseExecuteContext = resolveBaseExecuteContext()

  try {
    const { WorkflowExecute } = require('n8n-core')

    if (WorkflowExecute?.prototype?.__n8nOtelPatched) {
      if (debug) {
        console.log(`${logPrefix}: Workflow tracing already patched`)
      }
      return
    }

    const originalSetupExecution = WorkflowExecute.prototype.setupExecution
    WorkflowExecute.prototype.setupExecution = function () {
      const setupResult = originalSetupExecution.apply(this, arguments)
      try {
        const hooks = setupResult?.hooks || this?.additionalData?.hooks
        const existingState = hooks?.__n8nOtelState
        const state = existingState || ensureTracingState(this, tracer)
        this.__n8nOtelState = state

        if (hooks) {
          state.hooks = hooks
          hooks.__n8nOtelState = state
          hooks.__n8nOtelExecution = this
          hooks.__n8nOtelNodeSpanStore = state.nodeSpanStore
          hooks.__n8nOtelNodeSpanByName = state.nodeSpanByName
          hooks.__n8nOtelSyntheticAgentSpans = state.syntheticAgentSpans
          hooks.__n8nOtelToolInputStore = state.toolInputStore

          this.__n8nOtelHooks = hooks
          if (BaseExecuteContext?.prototype?.logAiEvent) {
            hooks.__n8nOtelLogAiEvent = BaseExecuteContext.prototype.logAiEvent
          }
          hooks.__n8nOtelAdditionalData = this?.additionalData
          hooks.__n8nOtelWorkflow = this?.workflow

          if (!hooks.__n8nOtelHooked) {
            attachTracingHooks(hooks, { tracer, logPrefix, debug })
            hooks.__n8nOtelHooked = true
          }
        }
      } catch (error) {
        console.warn(`${logPrefix}: Failed to attach lifecycle hooks: ${error.message}`)
      }
      return setupResult
    }

    const originalProcessRunExecutionData = WorkflowExecute.prototype.processRunExecutionData
    if (!WorkflowExecute.prototype.__n8nOtelProcessRunPatched) {
      WorkflowExecute.prototype.processRunExecutionData = function () {
        const hooks = this.__n8nOtelHooks || this?.additionalData?.hooks
        const state = hooks?.__n8nOtelState || ensureTracingState(this, tracer)
        this.__n8nOtelState = state
        if (hooks && !hooks.__n8nOtelState) {
          hooks.__n8nOtelState = state
        }
        if (hooks) {
          state.hooks = hooks
        }

        const workflow = arguments?.[0] || this?.workflow
        startWorkflowSpan(state, workflow, {
          tracer,
          logPrefix,
          debug,
          source: 'processRunExecutionData',
        })

        if (this?.additionalData?.restartExecutionId) {
          markWorkflowResume(state, 'additionalData.restartExecutionId')
        }

        let runResult
        try {
          runResult = originalProcessRunExecutionData.apply(this, arguments)
        } catch (error) {
          recordSpanError(state.workflowSpan, error)
          finalizeExecutionState(state, { logPrefix, debug })
          throw error
        }

        if (runResult && typeof runResult.then === 'function') {
          runResult
            .then((fullRunData) => {
              const runError = fullRunData?.data?.resultData?.error
              if (runError) {
                recordSpanError(state.workflowSpan, runError)
              }
            })
            .catch((error) => {
              recordSpanError(state.workflowSpan, error)
            })
            .finally(() => {
              finalizeExecutionState(state, { logPrefix, debug })
            })
          return runResult
        }

        finalizeExecutionState(state, { logPrefix, debug })
        return runResult
      }
      WorkflowExecute.prototype.__n8nOtelProcessRunPatched = true
    }

    const originalRunNode = WorkflowExecute.prototype.runNode
    if (!WorkflowExecute.prototype.__n8nOtelRunNodePatched) {
      WorkflowExecute.prototype.runNode = function () {
        const hooks = this.__n8nOtelHooks || this?.additionalData?.hooks
        const state = hooks?.__n8nOtelState || ensureTracingState(this, tracer)
        this.__n8nOtelState = state
        if (hooks && !hooks.__n8nOtelState) {
          hooks.__n8nOtelState = state
        }
        if (hooks) {
          state.hooks = hooks
        }

        const executionIndex = (this?.additionalData?.currentNodeExecutionIndex ?? 0) - 1
        const executionData = arguments?.[1]
        const nodeType = executionData?.node?.type ?? ''

        if (state.toolInputStore && isToolNodeType(nodeType)) {
          const toolInput = extractInputJson(executionData?.data)
          if (toolInput !== undefined) {
            state.toolInputStore.set(executionIndex, toolInput)
          }
        }

        const existingNodeSpan = state.nodeSpanStore.get(executionIndex)
        if (existingNodeSpan) {
          if (isAgentOrToolNode(nodeType)) {
            return originalRunNode.apply(this, arguments)
          }
          const spanContext = trace.setSpan(context.active(), existingNodeSpan)
          return context.with(spanContext, () => originalRunNode.apply(this, arguments))
        }

        if (!shouldUseRunNodeFallback(state)) {
          return originalRunNode.apply(this, arguments)
        }

        if (isAgentOrToolNode(nodeType)) {
          return originalRunNode.apply(this, arguments)
        }

        const fallbackSpan = createFallbackNodeSpan({
          tracer,
          executionContext: this,
          executionData,
          workflowSpan: state.workflowSpan,
        })

        if (!fallbackSpan) {
          return originalRunNode.apply(this, arguments)
        }

        state.fallbackNodeSpans.set(executionIndex, fallbackSpan)

        const fallbackCtx = trace.setSpan(context.active(), fallbackSpan)
        let runResult
        try {
          runResult = context.with(fallbackCtx, () => originalRunNode.apply(this, arguments))
        } catch (error) {
          recordSpanError(fallbackSpan, error)
          finishFallbackNodeSpan(state, executionIndex, fallbackSpan)
          throw error
        }

        if (runResult && typeof runResult.then === 'function') {
          return runResult
            .then((result) => {
              setFallbackNodeOutput(fallbackSpan, result)
              return result
            })
            .catch((error) => {
              recordSpanError(fallbackSpan, error)
              throw error
            })
            .finally(() => {
              finishFallbackNodeSpan(state, executionIndex, fallbackSpan)
            })
        }

        setFallbackNodeOutput(fallbackSpan, runResult)
        finishFallbackNodeSpan(state, executionIndex, fallbackSpan)
        return runResult
      }
      WorkflowExecute.prototype.__n8nOtelRunNodePatched = true
    }

    WorkflowExecute.prototype.__n8nOtelPatched = true
    console.log(`${logPrefix}: Workflow tracing patched successfully`)
  } catch (e) {
    console.error('Failed to set up n8n OpenTelemetry workflow tracing:', e)
  }
}

function createTracingState(tracer) {
  return {
    tracer,
    hooks: null,
    workflowSpan: null,
    nodeSpanStore: new Map(),
    nodeSpanByName: new Map(),
    syntheticAgentSpans: new Set(),
    toolInputStore: new Map(),
    fallbackNodeSpans: new Map(),
    hookRegistration: {
      workflowExecuteBefore: false,
      workflowExecuteResume: false,
      workflowExecuteAfter: false,
      nodeExecuteBefore: false,
      nodeExecuteAfter: false,
    },
    resumeRequested: false,
    resumeApplied: false,
    resumeSource: null,
  }
}

function ensureTracingState(execution, tracer) {
  if (execution?.__n8nOtelState) {
    return execution.__n8nOtelState
  }

  const state = createTracingState(tracer)
  if (execution && typeof execution === 'object') {
    execution.__n8nOtelState = state
  }
  return state
}

function buildWorkflowAttributes(workflow) {
  const wfData = workflow || {}
  const workflowAttributes = {
    'n8n.workflow.id': wfData?.id ?? '',
    'n8n.workflow.name': wfData?.name ?? '',
  }

  const flattenedSettings = safeFlatten(wfData?.settings)
  if (flattenedSettings) {
    for (const [key, value] of Object.entries(flattenedSettings)) {
      workflowAttributes[`n8n.workflow.settings.${key}`] =
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? value
          : safeStringify(value)
    }
  }

  return workflowAttributes
}

function startWorkflowSpan(
  state,
  workflow,
  { tracer, logPrefix = '[Tracing]', debug = false, source = 'unknown' },
) {
  if (!state) return null

  if (!state.workflowSpan) {
    const workflowData =
      workflow || state?.hooks?.__n8nOtelWorkflow || state?.hooks?.workflowData || {}
    state.workflowSpan = tracer.startSpan('n8n.workflow.execute', {
      attributes: buildWorkflowAttributes(workflowData),
      kind: SpanKind.INTERNAL,
    })
    if (state.hooks) {
      state.hooks.__n8nOtelWorkflowSpan = state.workflowSpan
    }

    if (debug) {
      const workflowName = workflowData?.name || 'unknown'
      console.debug(`${logPrefix}: starting n8n workflow via ${source}:`, workflowName)
    }
  }

  applyWorkflowResumeMark(state)
  return state.workflowSpan
}

function markWorkflowResume(state, source = 'unknown') {
  if (!state) return
  state.resumeRequested = true
  if (!state.resumeSource) {
    state.resumeSource = source
  }
  applyWorkflowResumeMark(state)
}

function applyWorkflowResumeMark(state) {
  if (!state?.workflowSpan || !state.resumeRequested || state.resumeApplied) return

  state.workflowSpan.setAttribute('n8n.workflow.resumed', true)
  state.workflowSpan.addEvent('workflow.resume', {
    source: state.resumeSource || 'unknown',
  })
  state.resumeApplied = true
}

function recordSpanError(span, error) {
  if (!span || !error) return
  try {
    span.recordException(error)
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: String(error?.message || error),
    })
  } catch (recordError) {
    // best effort
  }
}

function finalizeExecutionState(state, { fullRunData, logPrefix = '[Tracing]', debug = false } = {}) {
  if (!state) return

  const workflowSpan = state.workflowSpan
  if (workflowSpan) {
    const runError = fullRunData?.data?.resultData?.error
    if (runError) {
      recordSpanError(workflowSpan, runError)
    }

    try {
      workflowSpan.end()
    } catch (error) {
      if (debug) {
        console.warn(`${logPrefix}: Failed to end workflow span: ${error.message}`)
      }
    }
  }

  state.workflowSpan = null
  if (state.hooks) {
    state.hooks.__n8nOtelWorkflowSpan = null
  }

  for (const span of state.syntheticAgentSpans) {
    try {
      span.end()
    } catch (error) {
      // best effort
    }
  }

  for (const span of state.fallbackNodeSpans.values()) {
    try {
      span.end()
    } catch (error) {
      // best effort
    }
  }

  state.syntheticAgentSpans.clear()
  state.nodeSpanByName.clear()
  state.nodeSpanStore.clear()
  state.toolInputStore.clear()
  state.fallbackNodeSpans.clear()

  state.resumeRequested = false
  state.resumeApplied = false
  state.resumeSource = null
}

function shouldUseRunNodeFallback(state) {
  const registration = state?.hookRegistration
  if (!registration) return true

  return !registration.nodeExecuteBefore && !registration.nodeExecuteAfter
}

function createFallbackNodeSpan({ tracer, executionContext, executionData, workflowSpan }) {
  const node = executionData?.node
  if (!node) return null

  const nodeAttributes = {
    'n8n.workflow.id': executionContext?.workflow?.id ?? executionContext?.workflowData?.id ?? 'unknown',
    'n8n.execution.id': executionContext?.additionalData?.executionId ?? 'unknown',
    'n8n.node.type': node?.type ?? 'unknown',
    'n8n.node.name': node?.name ?? 'unknown',
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

  const parentCtx = workflowSpan
    ? trace.setSpan(context.active(), workflowSpan)
    : context.active()

  return tracer.startSpan(
    'n8n.node.execute',
    {
      attributes: nodeAttributes,
      kind: SpanKind.INTERNAL,
    },
    parentCtx,
  )
}

function setFallbackNodeOutput(span, runNodeResult) {
  if (!span || !runNodeResult || typeof runNodeResult !== 'object') return

  const outputJson = extractOutputJson(runNodeResult?.data)
  if (outputJson !== undefined) {
    span.setAttribute('n8n.node.output_json', safeStringify(outputJson))
  }
}

function finishFallbackNodeSpan(state, executionIndex, span) {
  if (!span) return
  try {
    span.end()
  } catch (error) {
    // best effort
  } finally {
    state?.fallbackNodeSpans?.delete(executionIndex)
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

function registerHook(hooks, hookName, handler, { state, logPrefix, debug }) {
  try {
    hooks.addHandler(hookName, handler)
    if (
      state?.hookRegistration &&
      Object.prototype.hasOwnProperty.call(state.hookRegistration, hookName)
    ) {
      state.hookRegistration[hookName] = true
    }
  } catch (error) {
    if (debug) {
      console.warn(`${logPrefix}: Failed to attach ${hookName} hook: ${error.message}`)
    }
  }
}

function attachTracingHooks(hooks, { tracer, logPrefix, debug }) {
  const state = hooks?.__n8nOtelState || createTracingState(tracer)
  hooks.__n8nOtelState = state
  state.hooks = hooks

  hooks.__n8nOtelNodeSpanStore = state.nodeSpanStore
  hooks.__n8nOtelNodeSpanByName = state.nodeSpanByName
  hooks.__n8nOtelSyntheticAgentSpans = state.syntheticAgentSpans
  hooks.__n8nOtelToolInputStore = state.toolInputStore

  registerHook(
    hooks,
    'workflowExecuteBefore',
    function (workflow) {
      startWorkflowSpan(state, workflow || this?.workflowData, {
        tracer,
        logPrefix,
        debug,
        source: 'workflowExecuteBefore',
      })
    },
    { state, logPrefix, debug },
  )

  registerHook(
    hooks,
    'workflowExecuteResume',
    function (workflow) {
      startWorkflowSpan(state, workflow || this?.workflowData, {
        tracer,
        logPrefix,
        debug,
        source: 'workflowExecuteResume',
      })
      markWorkflowResume(state, 'workflowExecuteResume')
    },
    { state, logPrefix, debug },
  )

  registerHook(
    hooks,
    'workflowExecuteAfter',
    function (fullRunData) {
      finalizeExecutionState(state, { fullRunData, logPrefix, debug })
    },
    { state, logPrefix, debug },
  )

  registerHook(
    hooks,
    'nodeExecuteBefore',
    function (nodeName, taskStartedData) {
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

      const existingSpan = state.nodeSpanByName.get(nodeName)
      const agentParentName = resolveAgentParentName(this, nodeName, taskStartedData)
      let parentSpan = state.workflowSpan

      if (agentParentName) {
        const agentSpan =
          state.nodeSpanByName.get(agentParentName) ||
          createSyntheticAgentSpan({
            executionContext: this,
            agentNodeName: agentParentName,
            workflowSpan: state.workflowSpan,
            tracer,
            syntheticAgentSpans: state.syntheticAgentSpans,
            nodeSpanByName: state.nodeSpanByName,
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
        existingSpan && state.syntheticAgentSpans.has(existingSpan)
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

      state.nodeSpanStore.set(taskStartedData?.executionIndex, nodeSpan)
      state.nodeSpanByName.set(nodeName, nodeSpan)
    },
    { state, logPrefix, debug },
  )

  registerHook(
    hooks,
    'nodeExecuteAfter',
    function (nodeName, taskData) {
      const spanKey = taskData?.executionIndex
      const existingSpan = state.nodeSpanStore.get(spanKey)
      const fallbackSpan = state.nodeSpanByName.get(nodeName)
      const node = this?.workflowData?.nodes?.find((item) => item.name === nodeName)
      const nodeType = node?.type ?? ''

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
          state.workflowSpan
            ? trace.setSpan(context.active(), state.workflowSpan)
            : context.active(),
        )

      try {
        if (taskData?.error) {
          recordSpanError(nodeSpan, taskData.error)
        }

        if (isToolNodeName(this?.workflowData, nodeName) || isToolNodeType(nodeType)) {
          const toolInput = state.toolInputStore.get(spanKey)
          const toolOutput = extractOutputJson(taskData?.data)
          const logAiEvent = hooks.__n8nOtelLogAiEvent
          if (typeof logAiEvent === 'function') {
            const agentParentName = resolveAgentParentName(this, nodeName, taskData)
            const agentNode =
              agentParentName &&
              this?.workflowData?.nodes?.find((item) => item.name === agentParentName)
            const fakeContext = {
              additionalData: hooks.__n8nOtelAdditionalData,
              node: node || { name: nodeName, type: nodeType },
              workflow: hooks.__n8nOtelWorkflow || this?.workflowData,
              parentNode: agentNode,
            }
            const payload = {
              input: toolInput,
              response: toolOutput,
              tool: { name: nodeName },
              _source: 'workflow-tool',
              _executionIndex: spanKey,
            }
            try {
              logAiEvent.call(fakeContext, 'ai-tool-called', safeStringify(payload))
            } catch (error) {
              if (debug) {
                console.warn(`${logPrefix}: Failed to emit tool event: ${error.message}`)
              }
            }
          }
        }

        const outputJson = extractOutputJson(taskData?.data)
        if (outputJson !== undefined) {
          nodeSpan.setAttribute('n8n.node.output_json', safeStringify(outputJson))
        }
      } catch (error) {
        console.warn('Failed to set node output attributes: ', error)
      } finally {
        try {
          nodeSpan.end()
        } catch (error) {
          // best effort
        }

        state.nodeSpanStore.delete(spanKey)
        state.toolInputStore.delete(spanKey)
        state.fallbackNodeSpans.delete(spanKey)

        if (state.nodeSpanByName.get(nodeName) === nodeSpan) {
          state.nodeSpanByName.delete(nodeName)
        }

        if (state.syntheticAgentSpans.has(nodeSpan)) {
          state.syntheticAgentSpans.delete(nodeSpan)
        }
      }
    },
    { state, logPrefix, debug },
  )
}

function extractOutputJson(taskDataConnections) {
  if (!taskDataConnections || typeof taskDataConnections !== 'object') return undefined
  const main = taskDataConnections.main
  if (Array.isArray(main) && Array.isArray(main[0])) {
    return main[0].map((item) => item?.json)
  }
  return taskDataConnections
}

function extractInputJson(taskDataConnections) {
  if (!taskDataConnections || typeof taskDataConnections !== 'object') return undefined
  const collected = {}
  for (const [key, value] of Object.entries(taskDataConnections)) {
    if (!Array.isArray(value) || !Array.isArray(value[0])) continue
    collected[key] = value[0].map((item) => item?.json ?? item)
  }
  const keys = Object.keys(collected)
  if (!keys.length) return taskDataConnections
  if (keys.length === 1) return collected[keys[0]]
  return collected
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

function isToolNodeName(workflowData, nodeName) {
  if (!workflowData || !nodeName) return false
  const node = workflowData?.nodes?.find((item) => item.name === nodeName)
  if (isToolNodeType(node?.type)) return true
  const connections = workflowData?.connections?.[nodeName]
  return Array.isArray(connections?.ai_tool)
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

function isToolNodeType(nodeType) {
  if (typeof nodeType !== 'string') return false
  return nodeType.toLowerCase().includes('.tool')
}

function resolveBaseExecuteContext() {
  const candidates = [
    'n8n-core/dist/execution-engine/node-execution-context/base-execute-context',
    'n8n-core/dist/execution-engine/node-execution-context/base-execute-context.js',
    'n8n-core/src/execution-engine/node-execution-context/base-execute-context',
    'n8n-core/src/execution-engine/node-execution-context/base-execute-context.js',
  ]

  for (const candidate of candidates) {
    try {
      const mod = require(candidate)
      const BaseExecuteContext = mod?.BaseExecuteContext || mod?.default || mod
      if (BaseExecuteContext?.prototype?.logAiEvent) {
        return BaseExecuteContext
      }
    } catch (error) {
      continue
    }
  }

  return null
}

module.exports = { setupWorkflowTracing }
