# Dockerfile
ARG N8N_VERSION=2.6.4
FROM docker.n8n.io/n8nio/n8n:${N8N_VERSION}

USER root

# Create machine-id
# This fixes OTEL log error messages
RUN mkdir -p /var/lib/dbus && \
    cat /proc/sys/kernel/random/uuid | tr -d '-' > /var/lib/dbus/machine-id


# Install OpenTelemetry dependencies required by tracing.js
RUN mkdir -p /opt/opentelemetry
WORKDIR /opt/opentelemetry
COPY ./tracing/package.json package.json
COPY ./tracing/package-lock.json package-lock.json
COPY ./tracing/tracing.js tracing.js
RUN chown node:node ./*.js
RUN npm install

# Create a symlink to n8n-core in the OpenTelemetry node_modules directory
# tracing.js patches n8n-core to trace workflow executions
RUN mkdir -p /opt/opentelemetry/node_modules/n8n-core
RUN ln -sf /usr/local/lib/node_modules/n8n/node_modules/n8n-core/* /opt/opentelemetry/node_modules/n8n-core/

# Switch to n8n's installation directory
WORKDIR /usr/local/lib/node_modules/n8n

# Install langfuse dependencies in n8n directory to use langfuse in n8n code nodes
# RUN npm install \
#     langfuse \
#     langfuse-langchain

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN echo "Setting entrypoint permissions..." && \
    chmod +x /docker-entrypoint.sh && \
    chown node:node /docker-entrypoint.sh

USER node

ENTRYPOINT ["tini", "--", "/docker-entrypoint.sh"]
