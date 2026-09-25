/**
 * Composio's project key stays on the server. Every request uses a session
 * created for one Workbench owner with an explicit toolkit and tool allowlist.
 * Helpers reach this client only through daemon operations that check the
 * connector row and the active command's human source.
 */
import { validateComposioScope, type ComposioScope } from '@beeline/api-contract/composio';

type Fetch = typeof fetch;
type Json = Record<string, unknown>;

const API = 'https://backend.composio.dev/api/v3.1';

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid Composio response');
  return value as Json;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('invalid Composio response');
  return value;
}

export class ComposioClient {
  constructor(
    private readonly apiKey: string,
    private readonly request: Fetch = fetch,
  ) {
    if (!apiKey) throw new Error('Composio project key is unavailable on this server');
  }

  private async json(path: string, method: 'GET' | 'POST', body?: Json): Promise<Json> {
    const response = await this.request(`${API}${path}`, {
      method,
      headers: {
        'x-api-key': this.apiKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Composio request failed (${response.status})`);
    return object(await response.json());
  }

  async createSession(scope: ComposioScope): Promise<string> {
    validateComposioScope(scope);
    const tools = Object.fromEntries(
      scope.toolkits.map((toolkit) => [toolkit, { enabled: scope.tools[toolkit] }]),
    );
    const response = await this.json('/tool_router/session', 'POST', {
      user_id: scope.ownerId,
      toolkits: { enabled: scope.toolkits },
      tools,
      manage_connections: { enabled: true },
      search: { enable: false },
      execute: { enable_multi_execute: false },
      workbench: { enable: false, proxy_execution_enabled: false },
    });
    return string(response.session_id);
  }

  async link(sessionId: string, toolkit: string, scope: ComposioScope): Promise<string> {
    validateComposioScope(scope);
    if (!scope.toolkits.includes(toolkit)) throw new Error('Composio toolkit is out of scope');
    const response = await this.json(
      `/tool_router/session/${encodeURIComponent(sessionId)}/link`,
      'POST',
      { toolkit },
    );
    const url = string(response.redirect_url);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'app.composio.dev')
      throw new Error('invalid Composio sign-in URL');
    return url;
  }

  async connected(sessionId: string, toolkit: string, scope: ComposioScope): Promise<boolean> {
    validateComposioScope(scope);
    if (!scope.toolkits.includes(toolkit)) throw new Error('Composio toolkit is out of scope');
    const response = await this.json(
      `/tool_router/session/${encodeURIComponent(sessionId)}/toolkits?search=${encodeURIComponent(toolkit)}&limit=50`,
      'GET',
    );
    if (!Array.isArray(response.items)) throw new Error('invalid Composio response');
    const entry = response.items.find((item) => {
      const row = object(item);
      return row.slug === toolkit;
    });
    if (!entry) return false;
    const account = object(entry).connected_account;
    return Boolean(account && object(account).status === 'ACTIVE' &&
      object(account).user_id === scope.ownerId);
  }

  async execute(
    sessionId: string,
    scope: ComposioScope,
    toolkit: string,
    tool: string,
    args: Json,
  ): Promise<{ data: unknown; logId?: string }> {
    validateComposioScope(scope);
    if (!scope.tools[toolkit]?.includes(tool)) throw new Error('Composio tool is out of scope');
    if (!(await this.connected(sessionId, toolkit, scope)))
      throw new Error('Composio account is not connected');
    const result = await this.json(
      `/tool_router/session/${encodeURIComponent(sessionId)}/execute`,
      'POST',
      { tool_slug: tool, arguments: args },
    );
    if (result.error) throw new Error('Composio tool execution failed');
    return { data: result.data, ...(typeof result.log_id === 'string' ? { logId: result.log_id } : {}) };
  }
}
