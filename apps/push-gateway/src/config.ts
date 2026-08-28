export interface PushGatewayConfig {
  databaseUrl: string;
  host: string;
  port: number;
  registryFile: string;
  pollIntervalMs: number;
  feedHeartbeatIntervalMs: number;
  indexerPublicOrigin: string;
}

function origin(value: string, name: string): string {
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an exact HTTP origin`);
  }
  return parsed.origin;
}

export function loadPushGatewayConfig(env: NodeJS.ProcessEnv = process.env): PushGatewayConfig {
  const databaseUrl = env.BUZZY_PUSH_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error('set BUZZY_PUSH_DATABASE_URL or DATABASE_URL');
  const registryFile = env.BUZZY_PUSH_REGISTRY_FILE ?? '.data/registrations.json';
  const host = env.BUZZY_PUSH_HOST ?? '127.0.0.1';
  const port = Number(env.PORT ?? '8788');
  const indexerPublicOrigin = origin(
    env.BUZZY_INDEXER_PUBLIC_ORIGIN ?? `http://${host}:${port}`,
    'BUZZY_INDEXER_PUBLIC_ORIGIN',
  );
  const indexerOriginUrl = new URL(indexerPublicOrigin);
  const loopbackIndexerOrigin =
    indexerOriginUrl.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(indexerOriginUrl.hostname);
  if (
    env.NODE_ENV === 'production' &&
    indexerOriginUrl.protocol !== 'https:' &&
    !loopbackIndexerOrigin
  ) {
    throw new Error('BUZZY_INDEXER_PUBLIC_ORIGIN must use https in production');
  }
  return {
    databaseUrl,
    host,
    port,
    registryFile,
    pollIntervalMs: Number(env.BUZZY_PUSH_POLL_INTERVAL_MS ?? '1500'),
    feedHeartbeatIntervalMs: Number(env.BUZZY_PUSH_FEED_HEARTBEAT_MS ?? '60000'),
    indexerPublicOrigin,
  };
}
