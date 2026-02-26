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
     * Patch the workflow execution
     *
     * Wrap the entire run in a workflow-level span and capture workflow details as attributes.
     */
    const originalProcessRun = WorkflowExecute.prototype.processRunExecutionData
    WorkflowExecute.prototype.processRunExecutionData = function (workflow) {
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
      const span = tracer.startSpan('n8n.workflow.execute', {
        attributes: workflowAttributes,
        kind: SpanKind.INTERNAL,
      })

      if (debug) {
        console.debug(`${logPrefix}: starting n8n workflow:`, workflow)
      }

      const activeContext = trace.setSpan(context.active(), span)
      return context.with(activeContext, () => {
        const cancelable = originalProcessRun.apply(this, arguments)
        cancelable
          .then(
            (result) => {
              if (result?.data?.resultData?.error) {
                const err = result.data.resultData.error
                span.recordException(err)
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: String(err.message || err),
                })
              }
            },
            (error) => {
              span.recordException(error)
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: String(error.message || error),
              })
            },
          )
          .finally(() => {
            span.end()
          })
        return cancelable
      })
    }

    /**
     * Patch the n8n node execution
     *
     * Wrap each node's run in a child span and capture node details as attributes.
     */
    const originalRunNode = WorkflowExecute.prototype.runNode
    WorkflowExecute.prototype.runNode = async function (
      workflow,
      executionData,
      runExecutionData,
      runIndex,
      additionalData,
      mode,
      abortSignal,
    ) {
      if (!this) {
        console.warn('WorkflowExecute context is undefined')
        return originalRunNode.apply(this, arguments)
      }

      const node = executionData?.node ?? 'unknown'
      const executionId = additionalData?.executionId ?? 'unknown'
      const userId = additionalData?.userId ?? 'unknown'
      const nodeAttributes = {
        'n8n.workflow.id': workflow?.id ?? 'unknown',
        'n8n.execution.id': executionId,
        'n8n.user.id': userId,
      }

      const flattenedNode = flatten(node ?? {}, { delimiter: '.' })
      for (const [key, value] of Object.entries(flattenedNode)) {
        if (typeof value === 'string' || typeof value === 'number') {
          nodeAttributes[`n8n.node.${key}`] = value
        } else {
          nodeAttributes[`n8n.node.${key}`] = JSON.stringify(value)
        }
      }

      if (debug) {
        console.debug(`${logPrefix} Executing node:`, node.name)
      }

      return tracer.startActiveSpan(
        'n8n.node.execute',
        { attributes: nodeAttributes, kind: SpanKind.INTERNAL },
        async (nodeSpan) => {
          try {
            const result = await originalRunNode.apply(this, [
              workflow,
              executionData,
              runExecutionData,
              runIndex,
              additionalData,
              mode,
              abortSignal,
            ])
            try {
              const outputData = result?.data?.[runIndex]
              const finalJson = outputData?.map((item) => item.json)
              nodeSpan.setAttribute(
                'n8n.node.output_json',
                JSON.stringify(finalJson),
              )
            } catch (error) {
              console.warn('Failed to set node output attributes: ', error)
            }
            return result
          } catch (error) {
            nodeSpan.recordException(error)
            nodeSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(error.message || error),
            })
            nodeSpan.setAttribute('n8n.node.status', 'error')
            throw error
          } finally {
            nodeSpan.end()
          }
        },
      )
    }

    WorkflowExecute.prototype.__n8nOtelPatched = true
    console.log(`${logPrefix}: Workflow tracing patched successfully`)
  } catch (e) {
    console.error('Failed to set up n8n OpenTelemetry workflow tracing:', e)
  }
}

module.exports = { setupWorkflowTracing }
