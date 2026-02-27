'use strict'

const { startObservation } = require('@langfuse/tracing')

const AI_EVENT_PREFIX = 'ai-'
const LANGFUSE_PREFIX = 'n8n.ai.'
const AGENT_TRACE_TTL_MS = 60000
let DEBUG_EVENTS = false

let NodeConnectionTypes = {
  AiLanguageModel: 'ai_languageModel',
  AiTool: 'ai_tool',
}
try {
  const workflow = require('n8n-workflow')
  if (workflow?.NodeConnectionTypes) {
    NodeConnectionTypes = workflow.NodeConnectionTypes
  }
} catch (error) {
  // best effort
}

function setupLlmTracing({
  logPrefix = '[Tracing]',
  debug = false,
  debugEvents = false,
  langfuseEnabled = false,
} = {}) {
  DEBUG_EVENTS = !!debugEvents
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

  const agentTraceStore = new Map()
  const originalLogAiEvent = BaseExecuteContext.prototype.logAiEvent

  BaseExecuteContext.prototype.logAiEvent = function (eventName, msg) {
    if (typeof eventName === 'string' && !eventName.startsWith(AI_EVENT_PREFIX)) {
      return originalLogAiEvent.apply(this, arguments)
    }

    try {
      const payload = safeParse(msg)
      const baseMetadata = buildMetadata(this, eventName)
      const agentContext = resolveAgentContext(this, eventName, baseMetadata)
      const normalized = normalizeEventPayload({
        eventName,
        payload,
        context: this,
        agentContext,
      })

      const agentTrace = getOrCreateAgentTrace(
        agentTraceStore,
        agentContext,
        normalized,
        baseMetadata,
      )

      const observation = buildLangfuseObservation({
        eventName,
        normalized,
        baseMetadata,
        agentContext,
        agentTrace,
      })

      let span
      if (observation) {
        span = agentTrace.rootSpan.startObservation(
          observation.name,
          observation.params,
          { asType: observation.asType },
        )
        if (span && typeof span.end === 'function') {
          span.end()
        }
      }

      updateAgentTrace(agentTrace, eventName, normalized)
      touchAgentTrace(agentTraceStore, agentTrace.key)

      if (debugEvents) {
        const payloadKeys =
          payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : []
        const inputPresent = observation?.params?.input !== undefined
        const outputPresent = observation?.params?.output !== undefined
        const usagePresent = observation?.params?.usageDetails !== undefined
        const modelPresent = observation?.params?.model !== undefined
        const inputSize = measurePayloadSize(observation?.params?.input)
        const outputSize = measurePayloadSize(observation?.params?.output)
        const metadataKeys =
          observation?.params?.metadata && typeof observation.params.metadata === 'object'
            ? Object.keys(observation.params.metadata).slice(0, 8).join(',')
            : ''
        const spanContext = resolveSpanContext(span)
        const traceId = spanContext?.traceId || agentTrace.rootSpan?.traceId || 'unknown'
        const spanId = spanContext?.spanId || 'unknown'
        console.log(
          `${logPrefix}: [LLM] event=${eventName} name=${observation?.name} trace=${traceId} span=${spanId} agent=${agentContext.agentName} input=${inputPresent} output=${outputPresent} usage=${usagePresent} model=${modelPresent} inputBytes=${inputSize} outputBytes=${outputSize} metadataKeys=${metadataKeys} payloadKeys=${payloadKeys.join(',')}`,
        )
        try {
          const rawPromptPreview =
            normalized?.rawPrompt && typeof normalized.rawPrompt === 'string'
              ? normalized.rawPrompt.slice(0, 4000)
              : normalized?.rawPrompt
          const messagesPreview = Array.isArray(normalized?.messages)
            ? normalized.messages.slice(0, 6)
            : normalized?.messages
          console.log(
            `${logPrefix}: [LLM] rawPrompt=${safeStringify(
              rawPromptPreview,
            )} messages=${safeStringify(messagesPreview)}`,
          )
        } catch (error) {
          console.warn(`${logPrefix}: [LLM] debug log failed: ${error.message}`)
        }
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

function buildMetadata(context, eventName) {
  return {
    eventName,
    workflowId: context?.workflow?.id ?? 'unknown',
    workflowName: context?.workflow?.name ?? 'Unnamed workflow',
    nodeName: context?.node?.name ?? 'unknown',
    nodeType: context?.node?.type ?? 'unknown',
    executionId: context?.additionalData?.executionId ?? 'unsaved-execution',
  }
}

function resolveObservationType(eventName) {
  if (eventName === 'ai-llm-generated-output') return 'generation'
  if (eventName === 'ai-llm-errored') return 'generation'
  if (eventName === 'ai-tool-called') return 'tool'
  return 'span'
}

function resolveAgentContext(context, eventName, metadata) {
  const workflow = context?.workflow
  const nodeName = context?.node?.name
  let agentName

  const parentNode = context?.parentNode
  if (parentNode && isAgentNodeType(parentNode.type)) {
    agentName = parentNode.name
    if (DEBUG_EVENTS) {
      console.log(
        `[Tracing]: [LLM] parent agent=${agentName} parentType=${parentNode.type}`,
      )
    }
  }

  if (!agentName) {
    const sourceAgent = resolveAgentFromSource(context, workflow, eventName)
    agentName = sourceAgent
  }

  if (!agentName) {
    const candidates = listAgentParentsFromConnections(workflow, nodeName)
    if (candidates.length === 1) {
      agentName = candidates[0]
    } else if (candidates.length > 1) {
      agentName = candidates[0]
      if (DEBUG_EVENTS) {
        console.log(
          `[Tracing]: [LLM] multiple agent candidates for node=${nodeName} using=${agentName} candidates=${candidates.join(
            ',',
          )}`,
        )
      }
    }
  }

  agentName = agentName || nodeName || 'unknown'
  const agentNode = workflow?.getNode ? workflow.getNode(agentName) : undefined

  return {
    key: `${metadata.workflowId}:${metadata.executionId}:${agentName}`,
    agentName,
    agentType: agentNode?.type ?? 'unknown',
    workflowId: metadata.workflowId,
    workflowName: metadata.workflowName,
    executionId: metadata.executionId,
  }
}

function resolveConnectionTypeForEvent(eventName) {
  if (eventName === 'ai-tool-called') return NodeConnectionTypes.AiTool
  return NodeConnectionTypes.AiLanguageModel
}

function resolveAgentFromSource(context, workflow, eventName) {
  const source = context?.executeData?.source
  if (!source || typeof source !== 'object') return undefined

  const preferredTypes = [
    NodeConnectionTypes.AiAgent,
    resolveConnectionTypeForEvent(eventName),
    NodeConnectionTypes.AiTool,
    NodeConnectionTypes.Main,
  ].filter(Boolean)

  const entries = collectSourceEntries(source)

  for (const connectionType of preferredTypes) {
    for (const entry of entries) {
      if (entry.connectionType !== connectionType) continue
      const previousNode = entry.source?.previousNode
      if (previousNode && isAgentNodeName(workflow, previousNode)) {
        if (DEBUG_EVENTS) {
          console.log(
            `[Tracing]: [LLM] source agent=${previousNode} type=${connectionType} index=${entry.index}`,
          )
        }
        return previousNode
      }
    }
  }

  for (const entry of entries) {
    const previousNode = entry.source?.previousNode
    if (previousNode && isAgentNodeName(workflow, previousNode)) {
      if (DEBUG_EVENTS) {
        console.log(
          `[Tracing]: [LLM] source agent fallback=${previousNode} type=${entry.connectionType} index=${entry.index}`,
        )
      }
      return previousNode
    }
  }

  if (DEBUG_EVENTS) {
    const keys = Object.keys(source)
    const sample = entries.slice(0, 6).map((entry) => ({
      type: entry.connectionType,
      index: entry.index,
      previousNode: entry.source?.previousNode,
    }))
    console.log(
      `[Tracing]: [LLM] no agent from source keys=${keys.join(',')} sample=${JSON.stringify(
        sample,
      )}`,
    )
  }

  return undefined
}

function collectSourceEntries(source) {
  const entries = []
  for (const [connectionType, value] of Object.entries(source)) {
    if (!Array.isArray(value)) continue
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index]
      if (!item) continue
      if (Array.isArray(item)) {
        for (const sub of item) {
          if (sub && typeof sub === 'object') {
            entries.push({ connectionType, index, source: sub })
          }
        }
        continue
      }
      if (typeof item === 'object') {
        entries.push({ connectionType, index, source: item })
      }
    }
  }
  return entries
}

function resolveAgentParentFromConnections(workflow, nodeName) {
  if (!workflow || !nodeName) return undefined
  const candidates = listAgentParentsFromConnections(workflow, nodeName)
  return candidates[0]
}

function listAgentParentsFromConnections(workflow, nodeName) {
  if (!workflow || !nodeName) return []
  const candidates = new Set()
  const connections = workflow?.connections?.[nodeName]
  if (connections) {
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
          if (targetNodeName && isAgentNodeName(workflow, targetNodeName)) {
            candidates.add(targetNodeName)
          }
        }
      }
    }
  }

  if (typeof workflow?.getChildNodes === 'function') {
    const childConnectionTypes = [
      NodeConnectionTypes.AiLanguageModel,
      NodeConnectionTypes.AiTool,
      NodeConnectionTypes.AiAgent,
    ].filter(Boolean)
    for (const connType of childConnectionTypes) {
      try {
        const children = workflow.getChildNodes(nodeName, connType)
        if (Array.isArray(children)) {
          for (const child of children) {
            if (child && isAgentNodeName(workflow, child)) {
              candidates.add(child)
            }
          }
        }
      } catch (error) {
        // best effort
      }
    }
  }

  return Array.from(candidates)
}

function isAgentNodeName(workflow, nodeName) {
  if (!workflow || !nodeName) return false
  const node = workflow?.getNode ? workflow.getNode(nodeName) : undefined
  return isAgentNodeType(node?.type)
}

function isAgentNodeType(nodeType) {
  if (typeof nodeType !== 'string') return false
  return nodeType.toLowerCase().includes('.agent')
}

function getOrCreateAgentTrace(store, agentContext, normalized, baseMetadata) {
  const existing = store.get(agentContext.key)
  if (existing) return existing

  const rootInput = sanitizeForLangfuse(buildRootInput(normalized))
  const rootMetadata = {
    workflowId: agentContext.workflowId,
    workflowName: agentContext.workflowName,
    executionId: agentContext.executionId,
    agentName: agentContext.agentName,
    agentType: agentContext.agentType,
    nodeName: baseMetadata?.nodeName,
    nodeType: baseMetadata?.nodeType,
  }

  const rootSpan = startObservation(`agent-run`, {
    metadata: sanitizeForLangfuse(rootMetadata),
    input: rootInput,
  })

  if (rootSpan?.updateTrace) {
    rootSpan.updateTrace({
      name: `${agentContext.workflowName} / ${agentContext.agentName}`,
      input: rootInput,
      metadata: sanitizeForLangfuse(rootMetadata),
    })
  }

  const entry = {
    key: agentContext.key,
    rootSpan,
    lastSeen: Date.now(),
    timer: null,
    generationCount: 0,
    toolCount: 0,
    toolEventsSeen: new Set(),
    toolNativeSeen: new Set(),
    traceInputSet: !!rootInput,
  }

  store.set(agentContext.key, entry)
  scheduleAgentTraceCleanup(store, entry)
  return entry
}

function scheduleAgentTraceCleanup(store, entry) {
  if (entry.timer) {
    clearTimeout(entry.timer)
  }
  entry.timer = setTimeout(() => {
    const current = store.get(entry.key)
    if (!current) return
    try {
      current.rootSpan?.end?.()
    } catch (error) {
      // best effort
    }
    store.delete(entry.key)
  }, AGENT_TRACE_TTL_MS)
}

function touchAgentTrace(store, key) {
  const entry = store.get(key)
  if (!entry) return
  entry.lastSeen = Date.now()
  scheduleAgentTraceCleanup(store, entry)
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

function normalizeEventPayload({ eventName, payload, context, agentContext }) {
  const rawPrompt = payload?.messages ?? payload?.input ?? payload?.prompt
  const messages = normalizeMessages(rawPrompt)
  const model = resolveModel(payload) || resolveModelFromAgentType(agentContext?.agentType)
  const question = extractQuestion(messages, payload)
  const answer = extractAnswer(payload)
  const usageDetails = mapUsage(resolveUsage(payload))
  const toolName = resolveToolName(payload, context)
  const toolInput = resolveToolInput(payload)
  const toolOutput = resolveToolOutput(payload)
  const toolSource = payload?._source
  const toolExecutionIndex = payload?._executionIndex
  const toolCallId = payload?.toolCallId || payload?.tool_call_id || payload?.id

  return {
    eventName,
    messages,
    rawPrompt,
    model,
    question,
    answer,
    usageDetails,
    toolName,
    toolInput,
    toolOutput,
    toolSource,
    toolExecutionIndex,
    toolCallId,
  }
}

function buildLangfuseObservation({
  eventName,
  normalized,
  baseMetadata,
  agentContext,
  agentTrace,
}) {
  const asType = resolveObservationType(eventName)
  const metadata = sanitizeForLangfuse({
    ...baseMetadata,
    agentName: agentContext.agentName,
    agentType: agentContext.agentType,
    model: normalized.model,
  })

  if (eventName === 'ai-tool-called') {
    const toolLabel = normalizeName(normalized.toolName || 'tool')
    const toolKeyBase = `${agentContext.executionId}:${toolLabel}`
    const isWorkflowSource = normalized.toolSource === 'workflow-tool'
    if (!isWorkflowSource) {
      agentTrace.toolNativeSeen.add(toolKeyBase)
    } else if (agentTrace.toolNativeSeen.has(toolKeyBase)) {
      return null
    }
    const dedupeKey = `${toolKeyBase}:${normalized.toolExecutionIndex ?? normalized.toolCallId ?? 'na'}:${isWorkflowSource ? 'w' : 'n'}`
    if (agentTrace.toolEventsSeen.has(dedupeKey)) {
      return null
    }
    agentTrace.toolEventsSeen.add(dedupeKey)
    agentTrace.toolCount += 1
    return {
      asType: 'tool',
      name: `tool:${toolLabel}`,
      params: {
        metadata,
        input: sanitizeForLangfuse(normalized.toolInput),
        output: sanitizeForLangfuse(normalized.toolOutput),
      },
    }
  }

  if (eventName === 'ai-llm-generated-output' || eventName === 'ai-llm-errored') {
    agentTrace.generationCount += 1
    const generationName = formatGenerationName(
      agentContext.agentType,
      normalized.model,
      agentTrace.generationCount,
    )
    const params = { metadata }
    const messages =
      normalized.messages ||
      normalizeMessages(normalized.rawPrompt)
    if (messages) {
      params.input = sanitizeForLangfuse({ messages })
    } else if (normalized.question) {
      params.input = sanitizeForLangfuse({ question: normalized.question })
    } else if (normalized.rawPrompt !== undefined) {
      params.input = sanitizeForLangfuse({ prompt: normalized.rawPrompt })
    }
    if (normalized.answer !== undefined) {
      params.output = sanitizeForLangfuse({ content: normalized.answer })
    }
    if (normalized.model) params.model = normalized.model
    if (normalized.usageDetails) {
      params.usageDetails = sanitizeForLangfuse(normalized.usageDetails)
    }

    if (eventName === 'ai-llm-errored' && normalized.answer === undefined) {
      params.output = sanitizeForLangfuse({ error: 'LLM error' })
    }

    return {
      asType: 'generation',
      name: generationName,
      params,
    }
  }

  return {
    asType: asType || 'span',
    name: `${LANGFUSE_PREFIX}${eventName}`,
    params: {
      metadata,
      input: normalized.question ? sanitizeForLangfuse({ question: normalized.question }) : undefined,
    },
  }
}

function updateAgentTrace(agentTrace, eventName, normalized) {
  if (!agentTrace?.rootSpan) return
  if (!agentTrace.traceInputSet) {
    const rootInput = sanitizeForLangfuse(buildRootInput(normalized))
    if (rootInput) {
      agentTrace.traceInputSet = true
      try {
        agentTrace.rootSpan.update?.({ input: rootInput })
        agentTrace.rootSpan.updateTrace?.({ input: rootInput })
      } catch (error) {
        // best effort
      }
    }
  }

  if (eventName === 'ai-llm-generated-output' && normalized.answer !== undefined) {
    const steps = agentTrace.generationCount + agentTrace.toolCount
    const output = sanitizeForLangfuse({ answer: normalized.answer, steps })
    try {
      agentTrace.rootSpan.update?.({ output })
      agentTrace.rootSpan.updateTrace?.({ output })
    } catch (error) {
      // best effort
    }
  }
}

function buildRootInput(normalized) {
  if (!normalized) return undefined
  const question = normalized.question
  const model = normalized.model
  if (question || model) {
    return { question, model }
  }
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

function resolveModelFromAgentType(agentType) {
  if (!agentType) return undefined
  return undefined
}

function resolveUsage(payload) {
  if (!payload) return undefined
  if (payload.tokenUsage || payload.tokenUsageEstimate || payload.usageDetails) {
    return payload.tokenUsage || payload.tokenUsageEstimate || payload.usageDetails
  }
  if (payload.response) {
    return (
      payload.response.tokenUsage ||
      payload.response.tokenUsageEstimate ||
      payload.response.llmOutput?.tokenUsage
    )
  }
  return undefined
}

function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const input = usage.promptTokens ?? usage.input ?? usage.inputTokens
  const output = usage.completionTokens ?? usage.output ?? usage.outputTokens
  const total =
    usage.totalTokens ??
    (input !== undefined && output !== undefined ? input + output : usage.total)
  if (input === undefined && output === undefined && total === undefined) return undefined
  return sanitizeForLangfuse({ input, output, total })
}

function resolveToolName(payload, context) {
  return payload?.tool?.name || context?.node?.name || 'tool'
}

function resolveToolInput(payload) {
  if (!payload) return undefined
  const input = {}
  if (payload.query !== undefined) input.query = payload.query
  if (payload.tool) input.tool = payload.tool
  if (payload.input !== undefined && payload.query === undefined) input.input = payload.input
  return Object.keys(input).length ? input : undefined
}

function resolveToolOutput(payload) {
  if (!payload) return undefined
  if (payload.response !== undefined) return { response: payload.response }
  return undefined
}

function normalizeMessages(messages) {
  if (!messages) return undefined

  if (Array.isArray(messages)) {
    const normalized = []
    for (const msg of messages) {
      if (typeof msg === 'string') {
        const parsed = parsePromptString(msg)
        if (parsed.length) {
          normalized.push(...parsed)
        } else {
          normalized.push({ role: 'user', content: msg })
        }
        continue
      }
      if (msg && typeof msg === 'object') {
        const id = Array.isArray(msg.id) ? msg.id.join('.') : msg.id
        const role =
          msg.role ||
          msg.type ||
          msg.kwargs?.role ||
          msg.data?.role ||
          msg._getType?.() ||
          inferRoleFromId(id) ||
          (msg.constructor && msg.constructor.name) ||
          'user'
        const content =
          msg.content ??
          msg.text ??
          msg.kwargs?.content ??
          msg.data?.content ??
          msg.data?.text ??
          msg.message ??
          msg.value ??
          JSON.stringify(msg)
        const parsed = typeof content === 'string' ? parsePromptString(content) : []
        if (parsed.length) {
          normalized.push(...parsed)
        } else {
          normalized.push({ role: String(role).toLowerCase(), content: String(content) })
        }
        continue
      }
    }
    return normalized.length ? normalized : undefined
  }

  if (typeof messages === 'string') {
    const parsed = parsePromptString(messages)
    return parsed.length ? parsed : [{ role: 'user', content: messages }]
  }

  if (messages && typeof messages === 'object') {
    return [
      {
        role:
          messages.role ||
          messages.type ||
          messages.kwargs?.role ||
          messages.data?.role ||
          inferRoleFromId(messages.id) ||
          'user',
        content:
          messages.content ??
          messages.text ??
          messages.kwargs?.content ??
          messages.data?.content ??
          messages.data?.text ??
          messages.message ??
          JSON.stringify(messages),
      },
    ]
  }

  return undefined
}

function parsePromptString(prompt) {
  if (!prompt || typeof prompt !== 'string') return []
  const regex =
    /(?:^|\n)(System|Human|User|AI|Assistant|Tool):\s*([\s\S]*?)(?=\n(?:System|Human|User|AI|Assistant|Tool):|$)/gi
  const messages = []
  let match
  while ((match = regex.exec(prompt)) !== null) {
    const role = roleFromLabel(match[1])
    const content = match[2]?.trim()
    if (content) {
      messages.push({ role, content })
    }
  }
  return messages
}

function roleFromLabel(label) {
  const normalized = String(label || '').toLowerCase()
  if (normalized === 'system') return 'system'
  if (normalized === 'human' || normalized === 'user') return 'user'
  if (normalized === 'assistant' || normalized === 'ai') return 'assistant'
  if (normalized === 'tool') return 'tool'
  return 'user'
}

function inferRoleFromId(id) {
  if (!id || typeof id !== 'string') return undefined
  if (id.includes('SystemMessage')) return 'system'
  if (id.includes('HumanMessage')) return 'user'
  if (id.includes('AIMessage')) return 'assistant'
  if (id.includes('ToolMessage')) return 'tool'
  return undefined
}

function extractQuestion(messages, payload) {
  const normalized = Array.isArray(messages)
    ? messages
    : normalizeMessages(payload?.messages ?? payload?.input ?? payload?.prompt)

  if (Array.isArray(normalized)) {
    for (let i = normalized.length - 1; i >= 0; i -= 1) {
      const msg = normalized[i]
      if (!msg || typeof msg !== 'object') continue
      const role = String(msg.role || '').toLowerCase()
      if (role === 'user' || role === 'human') {
        return msg.content
      }
    }
    const first = normalized[0]
    if (first?.content) return first.content
  }

  if (typeof payload?.query === 'string') return payload.query
  if (typeof payload?.input === 'string') return payload.input
  return undefined
}

function extractAnswer(payload) {
  if (!payload) return undefined
  const fromGenerations = payload?.response?.generations?.[0]?.[0]?.text
  if (fromGenerations !== undefined) return fromGenerations
  const fromNestedGenerations = payload?.response?.response?.generations?.[0]?.[0]?.text
  if (fromNestedGenerations !== undefined) return fromNestedGenerations
  if (payload?.response?.output !== undefined) return payload.response.output
  if (typeof payload?.response === 'string') return payload.response
  if (typeof payload?.output === 'string') return payload.output
  if (typeof payload?.result === 'string') return payload.result
  return undefined
}

function formatGenerationName(agentType, model, index) {
  const agentLabel = normalizeAgentType(agentType)
  const modelLabel = normalizeName(model || 'unknown-model')
  return `${agentLabel}-${modelLabel}-${index}`
}

function normalizeAgentType(agentType) {
  if (!agentType || typeof agentType !== 'string') return 'agent'
  const short = agentType.includes('.') ? agentType.split('.').pop() : agentType
  const kebab = short
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
  return normalizeName(kebab || 'agent')
}

function normalizeName(value) {
  if (value === undefined || value === null) return 'unknown'
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown'
}

function safeStringify(value, { maxStringLength = 4000 } = {}) {
  if (value === undefined) return 'undefined'
  try {
    const seen = new WeakSet()
    const json = JSON.stringify(value, (key, val) => {
      if (typeof val === 'bigint') return val.toString()
      if (typeof val === 'function') return '[Function]'
      if (typeof val === 'symbol') return val.toString()
      if (val instanceof Error) {
        return { name: val.name, message: val.message }
      }
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[Circular]'
        seen.add(val)
      }
      return val
    })
    if (!json) return 'undefined'
    if (json.length > maxStringLength) {
      return `${json.slice(0, maxStringLength)}…`
    }
    return json
  } catch (error) {
    return String(value)
  }
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
