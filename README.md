# n8n_otel_2

Custom n8n image with OpenTelemetry instrumentation.

**What this is for**
- Run n8n with OpenTelemetry traces out of the box.
- Use the same image for `main`, `webhook`, and `worker` services.

**Docker image**
- Docker Hub: `gabrielhmsantos/n8n-otel`
- Tags follow the n8n version (example: `gabrielhmsantos/n8n-otel:2.9.4`).
- `latest` is updated when the workflow runs without a specific version.

**Requirements**
This example expects external services (managed or separate stack):
- PostgreSQL
- Redis

**Quick start (Docker Compose)**
A ready-to-use compose file is provided at `.examples/docker-compose.yaml`.

Steps:
1. Copy `.env.example` to `.env` and update the placeholders.
2. Run:

```bash
docker compose -f .examples/docker-compose.yaml --env-file .env up -d
```

You must replace at least:
- `POSTGRES_HOST`, `POSTGRES_PASSWORD`
- `REDIS_HOST`
- `N8N_ENCRYPTION_KEY`
- `N8N_RUNNERS_AUTH_TOKEN`
- `N8N_HOST`, `N8N_EDITOR_BASE_URL`, `WEBHOOK_URL`

**OpenTelemetry configuration**
Use one of the scenarios below. Set them in your `.env`.

Scenario A: full pipeline (traces + logs + metrics)
Use when your backend accepts logs and metrics (Honeycomb, Datadog, New Relic, etc.).

```bash
OTEL_SDK_DISABLED=false
OTEL_SERVICE_NAME=n8n
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.com
OTEL_LOG_LEVEL=INFO
```

Scenario B: traces only
Use when traces go to Tempo or Elastic APM and logs are handled elsewhere (e.g., Loki).

```bash
OTEL_SDK_DISABLED=false
OTEL_SERVICE_NAME=n8n
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://tempo.example.com
OTEL_LOGS_EXPORTER=none
OTEL_METRICS_EXPORTER=none
```

Authentication (if required):

```bash
OTEL_EXPORTER_OTLP_HEADERS=authorization=change_me
```

Tracing level:

```bash
TRACING_LOG_LEVEL=info
```

**Contributing**
We welcome contributions that improve the OpenTelemetry experience in n8n. Here are some high‑impact areas:
- Enhancements to tracing instrumentation.
- Better span naming and richer span attributes.
- Correlation between traces, metrics, and logs.
- Suggestions for collector integrations and pipelines.
- Performance optimizations (startup time, memory, CPU, and tracing overhead).
