# Base image for free starter agents (one Fly Machine per agent, app
# beeline-free-agents). It holds the tools an agent works with and the
# Pi harness and the helper built from this image's exact release checkout.
FROM node:22-bookworm-slim AS hosted-services
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates curl dbus-user-session git less novnc procps python3 python3-venv \
      ripgrep systemd websockify x11vnc xauth xvfb unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*
# The Squire broker uses headed Chrome and exposes its sign-in through noVNC.
# Install these at image build time, never during a person's connection request.
ARG CLOUDFLARED_VERSION=2026.10.5
RUN curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb \
  && apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb \
  && rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" -o /usr/local/bin/cloudflared \
  && chmod 755 /usr/local/bin/cloudflared
COPY infra/free-agent/hosted-services.sh infra/free-agent/reconcile-broker-marker.mjs /opt/beeline/
ARG SQUIRE_VERSION=1.1.39
RUN npm install --prefix /opt/beeline/squire --omit=dev --no-audit --no-fund "@trusty-squire/mcp@${SQUIRE_VERSION}" \
  && npm cache clean --force
COPY infra/free-agent/hosted-squire-broker.service /etc/systemd/user/trusty-squire-broker.service
ENV XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus

FROM node:22-bookworm-slim AS helper-build
WORKDIR /build
COPY infra/free-agent/helper-bundle/ /bundle/
COPY infra/free-agent/bake-helper.mjs /build/
ARG BEELINE_RELEASE_VERSION
ARG BEELINE_RELEASE_SHA
RUN node bake-helper.mjs "$BEELINE_RELEASE_VERSION" "$BEELINE_RELEASE_SHA"

FROM hosted-services AS runtime
ARG PI_VERSION=0.84.3
ARG PI_ACP_VERSION=0.0.34
RUN test "$PI_VERSION" != latest && test "$PI_ACP_VERSION" != latest \
  && npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" "pi-acp@${PI_ACP_VERSION}" \
  && npm cache clean --force
COPY infra/free-agent/prepare-image.mjs /opt/beeline/
RUN node /opt/beeline/prepare-image.mjs
COPY web/install.sh infra/free-agent/entrypoint.sh /opt/beeline/
COPY --from=helper-build /root/.local/ /root/.local/
ARG BEELINE_RELEASE_VERSION
ARG BEELINE_RELEASE_SHA
LABEL app.usebeeline.release.version=$BEELINE_RELEASE_VERSION \
  app.usebeeline.release.sha=$BEELINE_RELEASE_SHA
ENV HOME=/root
ENV BEELINE_HOSTED_SERVICES=1
WORKDIR /root
STOPSIGNAL SIGTERM
CMD ["/bin/sh", "/opt/beeline/entrypoint.sh"]
