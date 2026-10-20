# Base image for free starter agents (one Fly Machine per agent, app
# beeline-free-agents). It holds the tools an agent works with and the
# Pi harness and the helper built from this image's exact release checkout.
FROM node:22-bookworm-slim AS helper-build
WORKDIR /build
COPY infra/free-agent/helper-bundle/ /bundle/
COPY infra/free-agent/bake-helper.mjs /build/
ARG BEELINE_RELEASE_VERSION
ARG BEELINE_RELEASE_SHA
RUN node bake-helper.mjs "$BEELINE_RELEASE_VERSION" "$BEELINE_RELEASE_SHA"

FROM node:22-bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates curl git less procps python3 python3-venv ripgrep unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*
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
WORKDIR /root
STOPSIGNAL SIGTERM
CMD ["/bin/sh", "/opt/beeline/entrypoint.sh"]
