# Base image for free starter agents (one Fly Machine per agent, app
# beeline-free-agents). It holds the tools an agent works with and the
# Pi harness; the Beeline helper itself is installed on first boot from
# the published bundle and refreshed on every cold boot (`entrypoint.sh`).
FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates curl git less procps python3 python3-venv ripgrep unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*
ARG PI_VERSION=0.84.3
ARG PI_ACP_VERSION=0.0.34
RUN test "$PI_VERSION" != latest && test "$PI_ACP_VERSION" != latest \
  && npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" "pi-acp@${PI_ACP_VERSION}" \
  && npm cache clean --force
COPY relay-stack/web/install.sh infra/free-agent/entrypoint.sh /opt/beeline/
ENV HOME=/root
WORKDIR /root
STOPSIGNAL SIGTERM
CMD ["/bin/sh", "/opt/beeline/entrypoint.sh"]
