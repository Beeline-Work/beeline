import { dirname, join } from 'node:path';

export interface PushGatewayConfig {
  databaseUrl: string;
  host: string;
  port: number;
  registryFile: string;
  deliveryStateFile: string;
  pollIntervalMs: number;
  feedHeartbeatIntervalMs: number;
  snapshotPublicOrigin: string;
  snapshotAuthBaseUrl: string;
  snapshotInternalToken?: string;
  snapshotPollIntervalMs: number;
  snapshotBurstCoalesceMs: number;
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
  const snapshotPublicOrigin = origin(
    env.BUZZY_SNAPSHOT_PUBLIC_ORIGIN ?? `http://${host}:${port}`,
    'BUZZY_SNAPSHOT_PUBLIC_ORIGIN',
  );
  if (env.NODE_ENV === 'production' && new URL(snapshotPublicOrigin).protocol !== 'https:') {
    throw new Error('BUZZY_SNAPSHOT_PUBLIC_ORIGIN must use https in production');
  }
  if (env.NODE_ENV === 'production' && !env.BUZZY_SNAPSHOT_INTERNAL_TOKEN) {
    throw new Error('BUZZY_SNAPSHOT_INTERNAL_TOKEN is required in production');
  }
  return {
    databaseUrl,
    host,
    port,
    registryFile,
    deliveryStateFile:
      env.BUZZY_PUSH_DELIVERY_STATE_FILE ?? join(dirname(registryFile), 'deliveries.json'),
    pollIntervalMs: Number(env.BUZZY_PUSH_POLL_INTERVAL_MS ?? '1500'),
    feedHeartbeatIntervalMs: Number(env.BUZZY_PUSH_FEED_HEARTBEAT_MS ?? '60000'),
    snapshotPublicOrigin,
    snapshotAuthBaseUrl: origin(
      env.BUZZY_SNAPSHOT_AUTH_BASE_URL ?? 'http://127.0.0.1:8789',
      'BUZZY_SNAPSHOT_AUTH_BASE_URL',
    ),
    ...(env.BUZZY_SNAPSHOT_INTERNAL_TOKEN
      ? { snapshotInternalToken: env.BUZZY_SNAPSHOT_INTERNAL_TOKEN }
      : {}),
    snapshotPollIntervalMs: Number(env.BUZZY_SNAPSHOT_POLL_INTERVAL_MS ?? '1000'),
    snapshotBurstCoalesceMs: Number(env.BUZZY_SNAPSHOT_BURST_COALESCE_MS ?? '75'),
  };
}
