FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/auth/package.json apps/auth/tsconfig.json ./apps/auth/
COPY apps/push-gateway/package.json apps/push-gateway/tsconfig.json ./apps/push-gateway/
COPY apps/body/package.json apps/body/tsconfig.json ./apps/body/
COPY apps/gate/package.json apps/gate/tsconfig.json ./apps/gate/
COPY packages/nostr/package.json packages/nostr/tsconfig.json ./packages/nostr/
COPY packages/api-contract/package.json packages/api-contract/tsconfig.json ./packages/api-contract/
COPY packages/buzz-client/package.json packages/buzz-client/tsconfig.json ./packages/buzz-client/
RUN npm ci --ignore-scripts

COPY apps/server/src ./apps/server/src
COPY apps/auth/src ./apps/auth/src
COPY apps/push-gateway/src ./apps/push-gateway/src
COPY apps/body/src ./apps/body/src
COPY apps/gate/src ./apps/gate/src
COPY packages/nostr/src ./packages/nostr/src
COPY packages/api-contract/src ./packages/api-contract/src
COPY packages/buzz-client/src ./packages/buzz-client/src
RUN npm run build -w @beeline/nostr \
  && npm run build -w @beeline/api-contract \
  && npm run build -w @beeline/buzz-client \
  && npm run build -w @beeline/gate \
  && npm run build -w @beeline/body \
  && npm run build -w @beeline/auth \
  && npm run build -w @beeline/push-gateway \
  && npm run build -w @beeline/server

FROM node:22-bookworm-slim AS runtime
ARG BEELINE_RELEASE_VERSION=development
ARG BEELINE_RELEASE_SHA=unknown
ENV NODE_ENV=production
ENV BEELINE_RELEASE_VERSION=$BEELINE_RELEASE_VERSION \
  BEELINE_RELEASE_SHA=$BEELINE_RELEASE_SHA
LABEL app.usebeeline.release.version=$BEELINE_RELEASE_VERSION \
  app.usebeeline.release.sha=$BEELINE_RELEASE_SHA
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/auth/package.json ./apps/auth/package.json
COPY apps/push-gateway/package.json ./apps/push-gateway/package.json
COPY apps/body/package.json ./apps/body/package.json
COPY apps/gate/package.json ./apps/gate/package.json
COPY packages/nostr/package.json ./packages/nostr/package.json
COPY packages/api-contract/package.json ./packages/api-contract/package.json
COPY packages/buzz-client/package.json ./packages/buzz-client/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/auth/dist ./apps/auth/dist
COPY --from=build /app/apps/push-gateway/dist ./apps/push-gateway/dist
COPY --from=build /app/apps/body/dist ./apps/body/dist
COPY --from=build /app/apps/gate/dist ./apps/gate/dist
COPY --from=build /app/packages/nostr/dist ./packages/nostr/dist
COPY --from=build /app/packages/api-contract/dist ./packages/api-contract/dist
COPY --from=build /app/packages/buzz-client/dist ./packages/buzz-client/dist
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
