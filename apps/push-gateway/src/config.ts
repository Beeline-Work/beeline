import { dirname, join } from 'node:path';

export interface PushGatewayConfig {
  queryRelayUrl: string;
  relayHost: string;
  host: string;
  port: number;
  registryFile: string;
  deliveryStateFile: string;
  pollIntervalMs: number;
  feedHeartbeatIntervalMs: number;
}

export function loadPushGatewayConfig(env: NodeJS.ProcessEnv = process.env): PushGatewayConfig {
  const queryRelayUrl = env.BUZZY_RELAY_URL ?? 'http://127.0.0.1:3010';
  const registryFile = env.BUZZY_PUSH_REGISTRY_FILE ?? '.data/registrations.json';
  return {
    queryRelayUrl,
    relayHost: env.BUZZY_RELAY_HOST ?? new URL(queryRelayUrl).host,
    host: env.BUZZY_PUSH_HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? '8788'),
    registryFile,
    deliveryStateFile:
      env.BUZZY_PUSH_DELIVERY_STATE_FILE ?? join(dirname(registryFile), 'deliveries.json'),
    pollIntervalMs: Number(env.BUZZY_PUSH_POLL_INTERVAL_MS ?? '1500'),
    feedHeartbeatIntervalMs: Number(env.BUZZY_PUSH_FEED_HEARTBEAT_MS ?? '60000'),
  };
}
