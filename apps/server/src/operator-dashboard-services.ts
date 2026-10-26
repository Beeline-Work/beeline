/** Operator-only dependency inventory. Evidence and exclusions: docs/operator-services.md. */
import type { OperatorFinances } from './operator-finances-contract.js';
type Environment = Record<string, string | undefined>;
type Billing = 'credits' | 'pay-as-you-go card' | 'fixed plan' | 'free';
type Service = {
  id: string; name: string; powers: string; envVars: string[]; billing: Billing;
  billingUrl: string; balanceNote: string;
};

const service = (id: string, name: string, powers: string, envVars: string[], billing: Billing,
  billingUrl: string, balanceNote = 'No balance API'): Service =>
  ({ id, name, powers, envVars, billing, billingUrl, balanceNote });

const inventory: Service[] = [
  service('openrouter', 'OpenRouter', 'Agent models, voice replies and memory embeddings',
    ['BEELINE_FREE_AGENT_MODEL_KEY', 'BEELINE_VOICE_OPENROUTER_API_KEY', 'OPENROUTER_EMBEDDING_API_KEY'],
    'credits', 'https://openrouter.ai/settings/credits', 'Account credits and per-key spending allowance'),
  service('cloudflare', 'Cloudflare', 'Voice: speech in and out through Workers AI; web hosting and DNS',
    ['CLOUDFLARE_WORKERS_AI_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    'pay-as-you-go card', 'https://dash.cloudflare.com/', 'No balance API; billable usage is cost already incurred, not remaining credit'),
  service('groq', 'Groq', 'Dictation: transcribe recorded speech', ['GROQ_API_KEY'],
    'pay-as-you-go card', 'https://console.groq.com/settings/billing'),
  service('fly', 'Fly.io', 'Server hosting, free agents and voice transport hosting',
    ['FLY_API_TOKEN', 'FLY_FREE_AGENT_API_TOKEN'], 'pay-as-you-go card', 'https://fly.io/dashboard',
    'Organization prepaid credit; zero does not imply service is stopped on monthly billing'),
  service('neon', 'Neon', 'PostgreSQL database', ['DATABASE_URL', 'DATABASE_LISTENER_URL'],
    'pay-as-you-go card', 'https://console.neon.tech/', 'No balance API with database credentials; management API requires a separate Neon key'),
  service('tigris', 'Tigris', 'Photo, file and artifact storage',
    ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT_URL_S3', 'BUCKET_NAME'],
    'pay-as-you-go card', 'https://console.tigris.dev/'),
  service('sentry', 'Sentry', 'Server, helper and app error monitoring', ['SENTRY_DSN', 'SENTRY_AUTH_TOKEN'],
    'pay-as-you-go card', 'https://sentry.io/settings/', 'No balance API with the ingestion DSN; organization usage needs a management token'),
  service('apns', 'Apple Push Notification service', 'iPhone push notifications',
    ['APNS_KEY_ID', 'APNS_KEY_P8_BASE64', 'APNS_TEAM_ID'], 'free', 'https://developer.apple.com/account/'),
  service('web-push', 'Web Push', 'Browser push notifications through the browser vendor',
    ['WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY'], 'free', 'https://web.dev/articles/push-notifications-overview'),
  service('google', 'Google', 'Android push through Firebase, Google sign-in and Play install reports',
    ['GOOGLE_APPLICATION_CREDENTIALS_JSON', 'BEELINE_PLAY_SERVICE_ACCOUNT_JSON'],
    'free', 'https://console.cloud.google.com/billing', 'No operating credit balance for Firebase Cloud Messaging or sign-in'),
  service('mcp-registry', 'MCP Registry', 'Discover app and tool servers', [],
    'free', 'https://registry.modelcontextprotocol.io/'),
  service('publicnode', 'PublicNode', 'Public blockchain RPC for Ethereum, Polygon and BNB wallets', [],
    'free', 'https://publicnode.com/'),
  service('base', 'Base', 'Public blockchain RPC for Base wallets', [], 'free', 'https://base.org/'),
  service('arbitrum', 'Arbitrum', 'Public blockchain RPC for Arbitrum wallets', [], 'free', 'https://arbitrum.io/'),
  service('optimism', 'Optimism', 'Public blockchain RPC for Optimism wallets', [], 'free', 'https://optimism.io/'),
  service('zora', 'Zora', 'Public blockchain RPC for Zora wallets', [], 'free', 'https://zora.energy/'),
  service('avalanche', 'Avalanche', 'Public blockchain RPC for Avalanche wallets', [], 'free', 'https://avax.network/'),
  service('apple-developer', 'Apple Developer', 'App signing and store distribution', [],
    'fixed plan', 'https://developer.apple.com/account/'),
  service('domains', 'Domain registration', 'Beeline service domain names', [],
    'fixed plan', 'https://dash.cloudflare.com/'),
  service('expo', 'Expo EAS', 'Mobile builds and over-the-air app updates', ['EXPO_TOKEN'],
    'pay-as-you-go card', 'https://expo.dev/accounts', 'No balance API available to the server; release token lives in CI'),
  service('github', 'GitHub', 'Repository access, pull requests, checks and releases',
    ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    'pay-as-you-go card', 'https://github.com/organizations/Beeline-Work/settings/billing',
    'No balance API with repository installation tokens; organization billing requires billing permissions'),
  service('composio', 'Composio', 'Connected app authentication and tool execution', ['BEELINE_COMPOSIO_API_KEY'],
    'pay-as-you-go card', 'https://platform.composio.dev/', 'No balance API; project usage counts do not provide remaining credits or quota'),
  service('telegram', 'Telegram', 'Deliver Sentry error reports to the operator',
    ['BEELINE_TELEGRAM_BOT_TOKEN', 'BEELINE_TELEGRAM_CHAT_ID'], 'free', 'https://telegram.org/'),
  service('coinbase', 'Coinbase CDP', 'User wallets, transactions and public asset prices',
    ['COINBASE_CDP_API_KEY_ID', 'COINBASE_CDP_API_KEY_SECRET', 'COINBASE_CDP_WALLET_SECRET'],
    'pay-as-you-go card', 'https://portal.cdp.coinbase.com/',
    'No provider credit balance API; wallet token balances belong to users and are not operating credits'),
  service('link', 'Link', 'Connect user payment wallets and issue payment credentials',
    ['BEELINE_LINK_CLIENT_ID', 'BEELINE_LINK_CLIENT_SECRET', 'BEELINE_LINK_PUBLISHABLE_KEY', 'BEELINE_LINK_TOKEN_KEY'],
    'free', 'https://link.com/', 'No operating credit balance API; user payment sources are private'),
];

type Reading = OperatorFinances['services'][number]['readings'][number];
type ServiceRow = Pick<OperatorFinances['services'][number],
  'id' | 'name' | 'powers' | 'envVars' | 'billing' | 'billingUrl' | 'balanceNote' | 'state' | 'balanceHealth' | 'readings'>;
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5000;
class BalanceReadError extends Error {}

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BalanceReadError('Provider returned an invalid balance');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response');
  return value as Record<string, unknown>;
}

/** Each factory owns its bounded process cache; simultaneous dashboard reads share one refresh. */
export function createDashboardServices(
  env: Environment = process.env, fetchImpl: typeof fetch = fetch, now: () => number = Date.now,
) {
  let cached: { expires: number; rows: ServiceRow[] } | undefined;
  let pending: Promise<ServiceRow[]> | undefined;
  async function json(url: string, key: string, body?: object): Promise<Record<string, unknown>> {
    const response = await fetchImpl(url, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new BalanceReadError(response.status === 401 || response.status === 403
      ? 'Provider refused billing access; a billing or management key may be required'
      : `Provider unavailable (HTTP ${response.status})`);
    return object(await response.json());
  }
  async function read(label: string, source: string, lowThreshold: number | null,
    operation: () => Promise<number | null>): Promise<Reading> {
    try {
      const raw = await operation();
      const value = raw === null ? null : finite(raw);
      return { label, source, state: 'measured', value, unit: 'USD', measuredAt: new Date(now()).toISOString(),
        low: lowThreshold === null || value === null ? null : value <= lowThreshold,
        note: value === null ? 'No per-key cap; this does not indicate unlimited account credit' : null };
    } catch (error) {
      // Never forward provider errors: they can include a key, URL, account ID or response body.
      return { label, source, state: 'unavailable', value: null, unit: 'USD', measuredAt: null,
        low: null, note: error instanceof BalanceReadError ? error.message
          : 'Unreadable: timeout or invalid provider response' };
    }
  }
  async function refresh(): Promise<ServiceRow[]> {
    return Promise.all(inventory.map(async (definition): Promise<ServiceRow> => {
      const readings: Reading[] = [];
      if (definition.id === 'openrouter') {
        const pairs = await Promise.all(definition.envVars.map(async name => {
          const key = env[name]?.trim();
          const source = 'https://openrouter.ai/api/v1/credits';
          const keySource = 'https://openrouter.ai/api/v1/key';
          // Keep each workload separate: keys may belong to different accounts. Never add them together.
          const pair = await Promise.all([
            read(`${name}: account credits`, source, 5, async () => {
              if (!key) throw new BalanceReadError('Server workload key is not configured');
              const data = object((await json(source, key)).data);
              return finite(data.total_credits) - finite(data.total_usage);
            }),
            read(`${name}: key allowance`, keySource, 5, async () => {
              if (!key) throw new BalanceReadError('Server workload key is not configured');
              const data = object((await json(keySource, key)).data);
              // null means no key cap, not unlimited account credit and not zero.
              return data.limit === null && data.limit_remaining === null ? null : finite(data.limit_remaining);
            }),
          ]);
          return pair;
        }));
        readings.push(...pairs.flat());
      } else if (definition.id === 'fly') {
        readings.push(await read('Organization prepaid credit', 'https://api.fly.io/graphql', null, async () => {
          const key = env.FLY_API_TOKEN || env.FLY_FREE_AGENT_API_TOKEN;
          if (!key) throw new BalanceReadError('Server has no Fly billing-capable token');
          const app = env.FLY_API_TOKEN ? env.FLY_APP_NAME || 'beeline-server'
            : env.FLY_FREE_AGENT_APP || 'beeline-free-agents';
          const result = await json('https://api.fly.io/graphql', key,
            { query: 'query($name: String!) { app(name:$name) { organization { creditBalance } } }', variables: { name: app } });
          if (result.errors) throw new Error('Provider error');
          // Fly represents creditBalance in cents.
          return finite(object(object(object(result.data).app).organization).creditBalance) / 100;
        }));
      }
      return { ...definition, state: readings.length === 0 ? 'no_balance_api'
        : readings.some(r => r.state === 'measured') ? 'measured' : 'unavailable',
        balanceHealth: !readings.length ? 'not_applicable' : readings.some(r => r.low) ? 'low'
          : readings.some(r => r.state === 'unavailable') ? 'unreadable' : 'ok', readings };
    }));
  }
  return async () => {
    if (cached && cached.expires > now()) return { cacheSeconds: CACHE_MS / 1000, services: cached.rows };
    pending ??= refresh().then(rows => {
      cached = { rows, expires: now() + CACHE_MS };
      return rows;
    }).finally(() => { pending = undefined; });
    return { cacheSeconds: CACHE_MS / 1000, services: await pending };
  };
}

