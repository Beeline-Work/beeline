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

function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !/(?:token|secret|password|credential|api[_-]?key|authorization|cookie)/i.test(key),
  ).map(([key, item]) => [key, stripSecrets(item, depth + 1)]));
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
      const error = new Error(`App provider request failed (${response.status})`);
      Object.assign(error, { status: response.status });
      throw error;
    }
    if (method === 'DELETE') return {};
    return object(await response.json());
  }

  async supportsOAuth(toolkit: string): Promise<boolean> {
    try {
      const row = await this.request(`/toolkits/${encodeURIComponent(toolkit)}?version=latest`, 'GET');
      return row.slug === toolkit && row.enabled !== false &&
        Array.isArray(row.composio_managed_auth_schemes) &&
        row.composio_managed_auth_schemes.some((scheme) =>
          typeof scheme === 'string' && scheme.toLowerCase() === 'oauth2');
    } catch (error) {
      if ((error as { status?: number }).status === 404) return false;
      throw error;
    }
  }

  private async authConfig(toolkit: string): Promise<string> {
    const query = new URLSearchParams({ toolkit_slug: toolkit, is_composio_managed: 'true', limit: '200' });
    const listed = await this.request(`/auth_configs?${query}`, 'GET');
    if (!Array.isArray(listed.items)) throw new Error('App provider returned an invalid response');
    const existing = listed.items.map(object).find((item) =>
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
    if (result.error || result.successfull === false || result.successful === false)
      throw new Error('App tool execution failed');
    return stripSecrets(result.data);
  }
}
