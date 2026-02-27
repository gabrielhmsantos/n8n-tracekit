'use strict'

const { startObservation } = require('@langfuse/tracing')

const AI_EVENT_PREFIX = 'ai-'
const LANGFUSE_PREFIX = 'n8n.ai.'

function setupLlmTracing({
  logPrefix = '[Tracing]',
  debug = false,
  debugEvents = false,
  langfuseEnabled = false,
} = {}) {
  if (!langfuseEnabled) {
    console.log(`${logPrefix}: Langfuse not configured, skipping LLM tracing`)
    return
  }

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
    if (typeof eventName === 'string' && !eventName.startsWith(AI_EVENT_PREFIX)) {
      return originalLogAiEvent.apply(this, arguments)
    }

    try {
      const payload = safeParse(msg)
      const { asType, params } = buildObservation({
        context: this,
        eventName,
        payload,
        payloadMode: 'full',
      })

      if (params) {
        const span = startObservation(`${LANGFUSE_PREFIX}${eventName}`, params, { asType })
        if (span && typeof span.end === 'function') {
          span.end()
        }

        if (debugEvents) {
          const metadata = params.metadata || {}
          const payloadKeys =
            payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : []
          const inputPresent = params.input !== undefined
          const outputPresent = params.output !== undefined
          const usagePresent = params.usageDetails !== undefined
          const modelPresent = params.model !== undefined
          const inputSize = measurePayloadSize(params.input)
          const outputSize = measurePayloadSize(params.output)
          const metadataKeys =
            params.metadata && typeof params.metadata === 'object'
              ? Object.keys(params.metadata).slice(0, 8).join(',')
              : ''
          const spanContext = resolveSpanContext(span)
          const traceId = spanContext?.traceId || 'unknown'
          const spanId = spanContext?.spanId || 'unknown'
          console.log(
            `${logPrefix}: [LLM] event=${eventName} type=${asType} trace=${traceId} span=${spanId} workflow=${metadata.workflowName} node=${metadata.nodeName} execution=${metadata.executionId} input=${inputPresent} output=${outputPresent} usage=${usagePresent} model=${modelPresent} inputBytes=${inputSize} outputBytes=${outputSize} metadataKeys=${metadataKeys} payloadKeys=${payloadKeys.join(',')}`,
          )
        }
      } else if (debugEvents) {
        console.warn(`${logPrefix}: [LLM] skipped event=${eventName} reason=missing-params`)
      }
    } catch (error) {
      if (debug) {
        console.warn(`${logPrefix}: Failed to record LLM trace: ${error.message}`)
      }
      if (debugEvents) {
        console.warn(`${logPrefix}: [LLM] failed event=${eventName} error=${error.message}`)
      }
    }

    return originalLogAiEvent.apply(this, arguments)
  }

  BaseExecuteContext.prototype.__n8nLangfusePatched = true
  console.log(`${logPrefix}: LLM tracing patched successfully`)
}

function buildObservation({ context, eventName, payload, payloadMode }) {
  const metadata = {
    eventName,
    workflowId: context?.workflow?.id ?? 'unknown',
    workflowName: context?.workflow?.name ?? 'Unnamed workflow',
    nodeName: context?.node?.name ?? 'unknown',
    nodeType: context?.node?.type ?? 'unknown',
    executionId: context?.additionalData?.executionId ?? 'unsaved-execution',
  }

  const asType = resolveObservationType(eventName)

  if (payloadMode === 'metadata') {
    if (typeof payload === 'string') {
      metadata.messageSize = payload.length
    }
  }

  const params = buildObservationParams({
    payload,
    metadata,
    asType,
    payloadMode,
  })

  return { asType, params }
}

function resolveObservationType(eventName) {
  if (eventName === 'ai-llm-generated-output') return 'generation'
  if (eventName === 'ai-llm-errored') return 'generation'
  if (eventName === 'ai-tool-called') return 'tool'
  return 'span'
}

function buildObservationParams({ payload, metadata, asType, payloadMode }) {
  if (payloadMode === 'none') {
    return { metadata: sanitizeForLangfuse(metadata) }
  }

  const input = sanitizeForLangfuse(resolveInput(payload))
  const output = sanitizeForLangfuse(resolveOutput(payload))
  const model = resolveModel(payload)
  const usageDetails = sanitizeForLangfuse(resolveUsage(payload))

  const metadataFull = { ...metadata }

  if (payload?.options && payloadMode === 'full') {
    metadataFull.options = payload.options
  }

  if (payload?.error && payloadMode === 'full') {
    metadataFull.error = payload.error
  }

  const params = { metadata: sanitizeForLangfuse(metadataFull) }

  if (input !== undefined) params.input = input
  if (output !== undefined) params.output = output
  if (model) params.model = model
  if (usageDetails) params.usageDetails = usageDetails

  if (asType === 'tool' && payload?.response !== undefined && payloadMode === 'full') {
    params.output = sanitizeForLangfuse(payload.response)
  }

  return params
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

function resolveInput(payload) {
  if (!payload) return undefined
  if (payload.messages !== undefined) return payload.messages
  if (payload.input !== undefined) return payload.input
  if (payload.query !== undefined) return { query: payload.query }
  if (payload.message !== undefined) return payload.message
  if (payload.prompt !== undefined) return payload.prompt
  return undefined
}

function resolveOutput(payload) {
  if (!payload) return undefined
  if (payload.response !== undefined) return payload.response
  if (payload.output !== undefined) return payload.output
  if (payload.result !== undefined) return payload.result
  const fallback = payload?.response?.generations?.[0]?.[0]?.text
  if (fallback !== undefined) return fallback
  return undefined
}

function resolveModel(payload) {
  if (!payload?.options) return undefined
  return (
    payload.options.model ||
    payload.options.modelName ||
    payload.options.model_id ||
    payload.options.modelId
  )
}

function resolveUsage(payload) {
  if (!payload) return undefined
  return payload.tokenUsage || payload.tokenUsageEstimate || payload.usageDetails
}

function sanitizeForLangfuse(value, { maxStringLength = 20000 } = {}) {
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
    return JSON.parse(json)
  } catch (error) {
    return String(value)
  }
}

function measurePayloadSize(value) {
  if (value === undefined) return 0
  try {
    return JSON.stringify(value).length
  } catch (error) {
    return -1
  }
}

function resolveSpanContext(span) {
  if (!span) return null
  const otelSpan = span?.otelSpan || span
  if (typeof otelSpan?.spanContext === 'function') {
    return otelSpan.spanContext()
  }
  if (otelSpan?._spanContext) return otelSpan._spanContext
  return null
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
