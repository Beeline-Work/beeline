FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/auth/package.json apps/auth/tsconfig.json ./apps/auth/
COPY packages/nostr/package.json packages/nostr/tsconfig.json ./packages/nostr/
RUN npm ci --ignore-scripts

COPY apps/auth/src ./apps/auth/src
COPY packages/nostr/src ./packages/nostr/src
RUN npm run build -w @beeline/nostr && npm run build -w @beeline/auth

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/auth/package.json ./apps/auth/package.json
COPY packages/nostr/package.json ./packages/nostr/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/apps/auth/dist ./apps/auth/dist
COPY --from=build /app/packages/nostr/dist ./packages/nostr/dist

USER node
EXPOSE 8789
CMD ["node", "apps/auth/dist/index.js"]
