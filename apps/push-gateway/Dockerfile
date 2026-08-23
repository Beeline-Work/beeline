FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/push-gateway/package.json apps/push-gateway/tsconfig.json ./apps/push-gateway/
COPY packages/nostr/package.json packages/nostr/tsconfig.json ./packages/nostr/
COPY packages/buzz-client/package.json packages/buzz-client/tsconfig.json ./packages/buzz-client/
RUN npm ci --ignore-scripts

COPY apps/push-gateway/src ./apps/push-gateway/src
COPY packages/nostr/src ./packages/nostr/src
COPY packages/buzz-client/src ./packages/buzz-client/src
RUN npm run build -w @beeline/nostr \
  && npm run build -w @beeline/buzz-client \
  && npm run build -w @beeline/push-gateway

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/push-gateway/package.json ./apps/push-gateway/package.json
COPY packages/nostr/package.json ./packages/nostr/package.json
COPY packages/buzz-client/package.json ./packages/buzz-client/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/apps/push-gateway/dist ./apps/push-gateway/dist
COPY --from=build /app/packages/nostr/dist ./packages/nostr/dist
COPY --from=build /app/packages/buzz-client/dist ./packages/buzz-client/dist

USER node
EXPOSE 8788
CMD ["node", "apps/push-gateway/dist/index.js"]
