#!/bin/sh
# docker-entrypoint.sh

echo "Custom n8n image with ffmpeg, Langfuse, and OpenTelemetry"

# Trust custom certificates if they exist
if [ -d /opt/custom-certificates ]; then
  echo "Trusting custom certificates from /opt/custom-certificates."
  export NODE_OPTIONS="--use-openssl-ca $NODE_OPTIONS"
  export SSL_CERT_DIR=/opt/custom-certificates
  c_rehash /opt/custom-certificates
fi

is_true() {
  value=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
  case "$value" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

workflow_enabled="${TRACING_WORKFLOW_ENABLED:-false}"
llm_enabled="${TRACING_LLM_ENABLED:-false}"

if is_true "$workflow_enabled" || is_true "$llm_enabled"; then
  echo "Starting n8n with OpenTelemetry instrumentation..."
  export NODE_PATH="/opt/opentelemetry/node_modules:/usr/local/lib/node_modules:${NODE_PATH}"
  exec node --require /opt/opentelemetry/tracing.js /usr/local/bin/n8n "$@"
else
  echo "Tracing disabled (TRACING_WORKFLOW_ENABLED=false and TRACING_LLM_ENABLED=false), starting n8n normally..."
  if [ "$#" -gt 0 ]; then
    exec n8n "$@"
  else
    exec n8n
  fi
fi
