'use strict'

const { startObservation } = require('@langfuse/tracing')

const PAYLOAD_MODES = new Set(['none', 'metadata', 'full'])

function setupLlmTracing({
  logPrefix = '[Tracing]',
  debug = false,
  payloadMode = 'metadata',
  langfuseEnabled = false,
} = {}) {
  if (!langfuseEnabled) {
    console.log(`${logPrefix}: Langfuse not configured, skipping LLM tracing`)
    return
  }

  const normalizedPayloadMode = PAYLOAD_MODES.has(payloadMode)
    ? payloadMode
    : 'metadata'

  const BaseExecuteContext = resolveBaseExecuteContext()
  if (!BaseExecuteContext || !BaseExecuteContext.prototype?.logAiEvent) {
    console.warn(`${logPrefix}: BaseExecuteContext not found, skipping LLM tracing`)
    return
  }

  if (BaseExecuteContext.prototype.__n8nLangfusePatched) {
    if (debug) {
      console.log(`${logPrefix}: LLM tracing already patched`)
    }
    return
  }

  const originalLogAiEvent = BaseExecuteContext.prototype.logAiEvent

  BaseExecuteContext.prototype.logAiEvent = function (eventName, msg) {
    try {
      const metadata = buildMetadata({
        context: this,
        eventName,
        msg,
        payloadMode: normalizedPayloadMode,
      })

      const span = startObservation(`n8n.${eventName}`, { metadata })
      span.end()
    } catch (error) {
      if (debug) {
        console.warn(`${logPrefix}: Failed to record LLM trace: ${error.message}`)
      }
    }

    return originalLogAiEvent.apply(this, arguments)
  }

  BaseExecuteContext.prototype.__n8nLangfusePatched = true
  console.log(`${logPrefix}: LLM tracing patched successfully`)
}

function buildMetadata({ context, eventName, msg, payloadMode }) {
  const metadata = {
    eventName,
    workflowId: context?.workflow?.id ?? 'unknown',
    workflowName: context?.workflow?.name ?? 'Unnamed workflow',
    nodeName: context?.node?.name ?? 'unknown',
    nodeType: context?.node?.type ?? 'unknown',
    executionId: context?.additionalData?.executionId ?? 'unsaved-execution',
  }

  if (payloadMode === 'metadata') {
    if (typeof msg === 'string') {
      metadata.messageSize = msg.length
    }
  }

  if (payloadMode === 'full') {
    metadata.payload = safeParse(msg)
  }

  return metadata
}

function safeParse(value) {
  if (value === undefined || value === null) return value
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value)
  } catch (error) {
    return value
  }
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

module.exports = { setupLlmTracing }
