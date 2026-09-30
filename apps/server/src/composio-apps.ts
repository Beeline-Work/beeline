/** Server-only Composio v3 boundary. Credentials and provider tokens never leave Composio. */
type Json = Record<string, unknown>;
const API = 'https://backend.composio.dev/api';

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('App provider returned an invalid response');
  return value as Json;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('App provider returned an invalid response');
  return value;
}

/** Names in the Workbench stay product names; these are server-side toolkit slugs. */
export function composioToolkitForApp(key: string): string {
  const known: Record<string, string> = {
    calendar: 'googlecalendar', drive: 'googledrive', docs: 'googledocs',
    sheets: 'googlesheets', googlecalendar: 'googlecalendar',
    googledrive: 'googledrive', googledocs: 'googledocs', googlesheets: 'googlesheets',
  };
  return known[key] ?? key;
}

function safeToolSlug(slug: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,119}$/.test(slug);
}

const BODY_READ_LIMIT = 4096;
const DETAIL_LIMIT = 500;
const ERROR_KEY = /^(?:error|message|detail|error_message)$/i;

function boundedDetail(text: string): string {
  return text.length <= DETAIL_LIMIT ? text : text.slice(0, DETAIL_LIMIT);
}

/** First string found at a common error key, recursing into objects and arrays. */
function firstErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (ERROR_KEY.test(key)) {
      if (typeof item === 'string' && item) return item;
      const nested = firstErrorMessage(item);
      if (nested) return nested;
    }
  }
  for (const item of Object.values(value)) {
    const nested = firstErrorMessage(item);
    if (nested) return nested;
  }
  return undefined;
}

/** Provider error detail from a string or an object: bounded, secret-stripped. */
function providerErrorDetail(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return boundedDetail(value);
  const found = firstErrorMessage(stripSecrets(value));
  return found ? boundedDetail(found) : undefined;
}

/** Read a response body bounded so a huge error dump cannot blow memory. */
async function readBoundedBody(response: Response, limit = BODY_READ_LIMIT): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let done = false;
  while (!done && out.length < limit) {
    const next = await reader.read();
    done = next.done;
    if (next.value) out += decoder.decode(next.value, { stream: true });
  }
  if (!done) await reader.cancel();
  return out.slice(0, limit);
}

function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !/(?:token|secret|password|credential|api[_-]?key|authorization|cookie)/i.test(key),
  ).map(([key, item]) => [key, stripSecrets(item, depth + 1)]));
}

/**
 * Enabled, non-managed OAuth2 configs are created by an operator in the Composio dashboard.
 * When several exist, the most recently created wins; ties fall back to the lowest id.
 */
function customOAuthConfig(items: readonly Json[], toolkit: string): Json | undefined {
  const created = (item: Json) => {
    const time = typeof item.created_at === 'string' ? Date.parse(item.created_at) : Number.NaN;
    return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
  };
  return items.filter((item) =>
    object(item.toolkit).slug === toolkit && item.auth_scheme === 'OAUTH2' &&
    item.is_composio_managed === false && item.status === 'ENABLED' &&
    typeof item.id === 'string' && item.id !== '',
  ).sort((a, b) => created(b) - created(a) || String(a.id).localeCompare(String(b.id)))[0];
}

export class ComposioApps {
  constructor(private readonly apiKey: string, private readonly transport: typeof fetch = fetch) {
    if (!apiKey) throw new Error('App provider is unavailable');
  }

  private async request(path: string, method: 'GET' | 'POST' | 'DELETE', data?: Json,
    version: 'v3' | 'v3.1' = 'v3'): Promise<Json> {
    const response = await this.transport(`${API}/${version}${path}`, {
      method,
      headers: {
        'x-api-key': this.apiKey,
        ...(data ? { 'content-type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const body = await readBoundedBody(response);
      let detail: string | undefined;
      try {
        detail = providerErrorDetail(JSON.parse(body) as unknown);
      } catch {
        if (body.trim()) detail = boundedDetail(body.trim());
      }
      const error = new Error(detail
        ? `App provider request failed (${response.status}): ${detail}`
        : `App provider request failed (${response.status})`);
      Object.assign(error, { status: response.status });
      throw error;
    }
    if (method === 'DELETE') return {};
    return object(await response.json());
  }

  async supportsOAuth(toolkit: string): Promise<boolean> {
    let row: Json;
    try {
      row = await this.request(`/toolkits/${encodeURIComponent(toolkit)}?version=latest`, 'GET');
    } catch (error) {
      if ((error as { status?: number }).status === 404) return false;
      throw error;
    }
    if (row.slug !== toolkit || row.enabled === false) return false;
    if (Array.isArray(row.composio_managed_auth_schemes) &&
      row.composio_managed_auth_schemes.some((scheme) =>
        typeof scheme === 'string' && scheme.toLowerCase() === 'oauth2')) return true;
    return customOAuthConfig(await this.authConfigs(toolkit), toolkit) !== undefined;
  }

  private async authConfigs(toolkit: string): Promise<Json[]> {
    const query = new URLSearchParams({ toolkit_slug: toolkit, limit: '200' });
    const listed = await this.request(`/auth_configs?${query}`, 'GET');
    if (!Array.isArray(listed.items)) throw new Error('App provider returned an invalid response');
    return listed.items.map(object);
  }

  /** An operator-created custom OAuth2 config wins over Composio's shared managed one. */
  private async authConfig(toolkit: string): Promise<string> {
    const items = await this.authConfigs(toolkit);
    const custom = customOAuthConfig(items, toolkit);
    if (custom) return requiredString(custom.id);
    const existing = items.find((item) =>
      object(item.toolkit).slug === toolkit && item.auth_scheme === 'OAUTH2' &&
      item.is_composio_managed === true && item.status === 'ENABLED');
    if (existing) return requiredString(existing.id);
    const created = await this.request('/auth_configs', 'POST', {
      toolkit: { slug: toolkit },
      auth_config: { type: 'use_composio_managed_auth', credentials: {}, restrict_to_following_tools: [] },
    });
    const config = object(created.auth_config);
    if (config.auth_scheme !== 'OAUTH2' || config.is_composio_managed !== true)
      throw new Error('App provider did not create managed OAuth');
    return requiredString(config.id);
  }

  async link(userId: string, toolkit: string): Promise<{ url: string; accountId: string; expiresAt: Date }> {
    const authConfigId = await this.authConfig(toolkit);
    const linked = await this.request('/connected_accounts/link', 'POST', {
      auth_config_id: authConfigId, user_id: userId,
    });
    const url = requiredString(linked.redirect_url);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' ||
      !(parsed.hostname === 'composio.dev' || parsed.hostname.endsWith('.composio.dev')))
      throw new Error('App provider returned an invalid sign-in link');
    const expiresAt = new Date(requiredString(linked.expires_at));
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())
      throw new Error('App provider returned an expired sign-in link');
    return { url, accountId: requiredString(linked.connected_account_id), expiresAt };
  }

  async completeAuth(sessionUri: string, userId: string): Promise<{ accountId: string; toolkit: string }> {
    if (!sessionUri || sessionUri.length > 4096) throw new Error('Invalid app sign-in session');
    const done = await this.request('/connected_accounts/complete_auth', 'POST', {
      session_uri: sessionUri, user_id: userId,
    }, 'v3.1');
    return { accountId: requiredString(done.connected_account_id), toolkit: requiredString(done.toolkit_slug) };
  }

  async account(accountId: string, userId: string, toolkit: string): Promise<boolean> {
    const row = await this.request(`/connected_accounts/${encodeURIComponent(accountId)}`, 'GET');
    return row.id === accountId && row.user_id === userId && row.status === 'ACTIVE' &&
      object(row.toolkit).slug === toolkit && row.is_disabled !== true;
  }

  async deleteAccount(accountId: string): Promise<void> {
    try {
      await this.request(`/connected_accounts/${encodeURIComponent(accountId)}`, 'DELETE');
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }

  async listTools(toolkit: string, query?: string): Promise<readonly {
    slug: string; name: string; description: string; inputParameters: unknown;
  }[]> {
    const params = new URLSearchParams({ toolkit_slug: toolkit, toolkit_versions: 'latest',
      include_deprecated: 'false', limit: '1000' });
    if (query) params.set('query', query.slice(0, 120));
    const result = await this.request(`/tools?${params}`, 'GET');
    if (!Array.isArray(result.items)) throw new Error('App provider returned an invalid response');
    return result.items.map(object).filter((row) =>
      safeToolSlug(String(row.slug ?? '')) && object(row.toolkit).slug === toolkit,
    ).map((row) => ({
      slug: requiredString(row.slug), name: requiredString(row.name),
      description: typeof row.description === 'string' ? row.description : '',
      inputParameters: stripSecrets(row.input_parameters ?? {}),
    }));
  }

  async execute(input: { accountId: string; userId: string; toolkit: string;
    tool: string; arguments: Json }): Promise<unknown> {
    if (!safeToolSlug(input.tool)) throw new Error('Invalid app tool');
    if (!(await this.account(input.accountId, input.userId, input.toolkit)))
      throw new Error('App connection is unavailable');
    const definition = await this.request(
      `/tools/${encodeURIComponent(input.tool)}?toolkit_versions=latest`, 'GET');
    if (object(definition.toolkit).slug !== input.toolkit)
      throw new Error('App tool does not belong to this connection');
    const result = await this.request(`/tools/execute/${encodeURIComponent(input.tool)}`, 'POST', {
      connected_account_id: input.accountId,
      user_id: input.userId,
      arguments: input.arguments,
      version: requiredString(definition.version),
    });
    if (result.error || result.successfull === false || result.successful === false) {
      const detail = providerErrorDetail(result.error);
      throw new Error(detail ? `App tool execution failed: ${detail}` : 'App tool execution failed');
    }
    return stripSecrets(result.data);
  }
}
