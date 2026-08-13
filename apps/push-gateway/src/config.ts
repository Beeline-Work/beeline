export interface PushGatewayConfig {
  queryRelayUrl: string;
  relayHost: string;
  subscriptionRelayUrl: string;
  host: string;
  port: number;
  registryFile: string;
  pollIntervalMs: number;
}

export function loadPushGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): PushGatewayConfig {
  const queryRelayUrl = env.BUZZY_RELAY_URL ?? 'http://127.0.0.1:3010';
  const subscriptionRelayUrl = env.BUZZY_RELAY_SUBSCRIPTION_URL ?? queryRelayUrl;
  return {
    queryRelayUrl,
    relayHost: env.BUZZY_RELAY_HOST ?? new URL(subscriptionRelayUrl).host,
    subscriptionRelayUrl,
    host: env.BUZZY_PUSH_HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? '8788'),
    registryFile: env.BUZZY_PUSH_REGISTRY_FILE ?? '.data/registrations.json',
    pollIntervalMs: Number(env.BUZZY_PUSH_POLL_INTERVAL_MS ?? '1500'),
  };
}
