'use strict'
/**
 * OpenTelemetry + Langfuse bootstrap for n8n.
 *
 * - Initializes OTEL SDK (traces + logs)
 * - Optionally registers LangfuseSpanProcessor (SDK)
 * - Delegates workflow/node tracing and LLM tracing to separate modules
 */

const opentelemetry = require('@opentelemetry/sdk-node')
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http')
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http')
const {
  getNodeAutoInstrumentations,
} = require('@opentelemetry/auto-instrumentations-node')
const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { resourceFromAttributes } = require('@opentelemetry/resources')
const {
  SEMRESATTRS_SERVICE_NAME,
} = require('@opentelemetry/semantic-conventions')
const { envDetector, hostDetector, processDetector } = require('@opentelemetry/resources')
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const winston = require('winston')

const { setupWorkflowTracing } = require('./workflow_tracing')
const { setupLlmTracing } = require('./llm_tracing')

const LOGPREFIX = '[Tracing]'
const LOG_LEVEL = getEnv('TRACING_LOG_LEVEL', 'info', false)
const DEBUG = LOG_LEVEL === 'debug'

// Process OTEL_* and LANGFUSE_* environment variables to strip quotes.
processEnvironmentVariables('OTEL_')
processEnvironmentVariables('LANGFUSE_')

console.log(`${LOGPREFIX}: Starting n8n OpenTelemetry instrumentation`)

// Configure OpenTelemetry auto-instrumentations
// Turn off auto-instrumentation for dns, net, tls, fs, pg
const autoInstrumentations = getNodeAutoInstrumentations({
  '@opentelemetry/instrumentation-dns': { enabled: false },
  '@opentelemetry/instrumentation-net': { enabled: false },
  '@opentelemetry/instrumentation-tls': { enabled: false },
  '@opentelemetry/instrumentation-fs': { enabled: false },
  '@opentelemetry/instrumentation-pg': {
    enabled: false,
  },
})

registerInstrumentations({
  instrumentations: [autoInstrumentations],
})

const langfuseEnabled = hasEnv('LANGFUSE_PUBLIC_KEY') && hasEnv('LANGFUSE_SECRET_KEY')
const workflowTracingEnabled = readBool(process.env.TRACING_WORKFLOW_ENABLED, true)
const llmTracingEnabled =
  process.env.TRACING_LLM_ENABLED !== undefined
    ? readBool(process.env.TRACING_LLM_ENABLED, false)
    : langfuseEnabled

if (workflowTracingEnabled) {
  console.log(`${LOGPREFIX}: Setting up workflow tracing...`)
  setupWorkflowTracing({ logPrefix: LOGPREFIX, debug: DEBUG })
} else {
  console.log(`${LOGPREFIX}: Workflow tracing disabled (TRACING_WORKFLOW_ENABLED=false)`)
}

if (llmTracingEnabled) {
  const payloadMode = (process.env.TRACING_LLM_PAYLOAD || 'metadata').toLowerCase()
  console.log(`${LOGPREFIX}: Setting up LLM tracing (payload=${payloadMode})...`)
  setupLlmTracing({
    logPrefix: LOGPREFIX,
    debug: DEBUG,
    payloadMode,
    langfuseEnabled,
  })
} else {
  console.log(`${LOGPREFIX}: LLM tracing disabled (TRACING_LLM_ENABLED=false)`)
}

// Configure Winston logger to log to console
console.log(`${LOGPREFIX}: Configuring Winston logger with level: ${LOG_LEVEL}`)
setupWinstonLogger(LOG_LEVEL)

// Configure and start the OpenTelemetry SDK
console.log(
  `${LOGPREFIX}: Configuring OpenTelemetry SDK with log level: ${process.env.OTEL_LOG_LEVEL}`,
)
const sdk = setupOpenTelemetryNodeSDK({ langfuseEnabled })

sdk.start()

////////////////////////////////////////////////////////////
// HELPER FUNCTIONS
////////////////////////////////////////////////////////////

/**
 * Get environment variable without surrounding quotes
 */
function getEnv(key, defaultValue = '', required = true) {
  const value = process.env[key] ?? defaultValue
  if (!value && required) {
    throw new Error(`Required environment variable ${key} is not set`)
  }
  return value ? value.replace(/^['"]|['"]$/g, '') : defaultValue
}

function hasEnv(key) {
  const value = process.env[key]
  return typeof value === 'string' && value.trim() !== ''
}

function readBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

/**
 * Process all environment variables with a prefix to strip quotes
 */
function processEnvironmentVariables(prefix) {
  const envVars = process.env
  for (const key in envVars) {
    if (key.startsWith(prefix)) {
      try {
        const cleanValue = getEnv(key, undefined, false)
        process.env[key] = cleanValue
        if (DEBUG) {
          console.log(`${LOGPREFIX}: Processed ${key}=${cleanValue}`)
        }
      } catch (error) {
        console.warn(`${LOGPREFIX}: Error processing ${key}: ${error.message}`)
      }
    }
  }
}

function awaitAttributes(detector) {
  return {
    async detect(config) {
      const resource = detector.detect(config)
      await resource.waitForAsyncAttributes?.()
      return resource
    },
  }
}

/**
 * Configure and start the OpenTelemetry SDK
 */
function setupOpenTelemetryNodeSDK({ langfuseEnabled }) {
  const spanProcessors = []

  // Always keep OTLP trace export (for generic OTEL backends)
  spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()))

  if (langfuseEnabled) {
    try {
      const { LangfuseSpanProcessor } = require('@langfuse/otel')
      spanProcessors.push(new LangfuseSpanProcessor())
      console.log(`${LOGPREFIX}: LangfuseSpanProcessor enabled`)
    } catch (error) {
      console.warn(`${LOGPREFIX}: Failed to load LangfuseSpanProcessor: ${error.message}`)
    }
  } else {
    console.log(`${LOGPREFIX}: LangfuseSpanProcessor disabled (missing LANGFUSE_* keys)`)
  }

  const sdk = new opentelemetry.NodeSDK({
    spanProcessors,
    logRecordProcessors: [
      new opentelemetry.logs.SimpleLogRecordProcessor(new OTLPLogExporter()),
    ],
    // Fix for https://github.com/open-telemetry/opentelemetry-js/issues/4638
    resourceDetectors: [
      awaitAttributes(envDetector),
      awaitAttributes(processDetector),
      awaitAttributes(hostDetector),
    ],
    resource: resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: getEnv('OTEL_SERVICE_NAME', 'n8n', false),
    }),
  })

  return sdk
}

/**
 * Configure the Winston logger
 *
 * - Logs uncaught exceptions to the console
 * - Logs unhandled promise rejections to the console
 * - Logs errors to the console
 */
function setupWinstonLogger(logLevel = 'info') {
  const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.json(),
    transports: [new winston.transports.Console()],
  })

  process.on('uncaughtException', async (err) => {
    console.error('Uncaught Exception', err)
    logger.error('Uncaught Exception', { error: err })
    const span = opentelemetry.trace.getActiveSpan()
    if (span) {
      span.recordException(err)
      span.setStatus({ code: 2, message: err.message })
    }
    try {
      await sdk.forceFlush()
    } catch (flushErr) {
      logger.error('Error flushing telemetry data', { error: flushErr })
    }
    process.exit(1)
  })

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection', { error: reason })
  })
}
