FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/auth/package.json apps/auth/tsconfig.json ./apps/auth/
COPY packages/nostr/package.json packages/nostr/tsconfig.json ./packages/nostr/
COPY packages/buzz-client/package.json packages/buzz-client/tsconfig.json ./packages/buzz-client/
RUN npm ci --ignore-scripts

COPY apps/auth/src ./apps/auth/src
COPY packages/nostr/src ./packages/nostr/src
COPY packages/buzz-client/src ./packages/buzz-client/src
RUN npm run build -w @beeline/nostr && npm run build -w @beeline/buzz-client && npm run build -w @beeline/auth

FROM node:22-bookworm-slim AS runtime

ARG BEELINE_RELEASE_VERSION=development
ARG BEELINE_RELEASE_SHA=unknown
ENV NODE_ENV=production \
  BEELINE_RELEASE_VERSION=$BEELINE_RELEASE_VERSION \
  BEELINE_RELEASE_SHA=$BEELINE_RELEASE_SHA
LABEL app.usebeeline.release.version=$BEELINE_RELEASE_VERSION \
  app.usebeeline.release.sha=$BEELINE_RELEASE_SHA
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/auth/package.json ./apps/auth/package.json
COPY packages/nostr/package.json ./packages/nostr/package.json
COPY packages/buzz-client/package.json ./packages/buzz-client/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/apps/auth/dist ./apps/auth/dist
COPY --from=build /app/packages/nostr/dist ./packages/nostr/dist
COPY --from=build /app/packages/buzz-client/dist ./packages/buzz-client/dist

USER node
EXPOSE 8789
CMD ["node", "apps/auth/dist/index.js"]
