# Base image for free starter agents (one Fly Machine per agent, app
# beeline-free-agents). It holds the tools an agent works with and the
# OpenCode harness; the Beeline helper itself is installed on first boot from
# the published bundle and refreshed on every cold boot (`entrypoint.sh`).
FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates curl git less procps python3 python3-venv ripgrep unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*
ARG OPENCODE_VERSION=1.18.31
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" && npm cache clean --force
COPY relay-stack/web/install.sh infra/free-agent/entrypoint.sh /opt/beeline/
ENV HOME=/root
WORKDIR /root
STOPSIGNAL SIGTERM
CMD ["/bin/sh", "/opt/beeline/entrypoint.sh"]
