import type { ConnectorAssignment } from '@beeline/api-contract/daemon';
import { RegistryMcpHostBroker, registryMcpProviderToken } from './registry-mcp.js';

type Job = Extract<ConnectorAssignment, { kind: 'provider-webhook' }>;
type Registration = { providerId: string; signingSecret: string;
  accountContext?: string; livemode?: boolean };

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parsedText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

/** A provider response must carry the requested id; a text blob is never success by itself. */
function findObject(value: unknown, predicate: (row: Record<string, unknown>) => boolean,
  depth = 0): Record<string, unknown> | undefined {
  if (depth > 8) return undefined;
  const row = object(parsedText(value));
  if (row) {
    if (predicate(row)) return row;
    for (const child of Object.values(row)) {
      const found = findObject(child, predicate, depth + 1);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findObject(child, predicate, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

async function linearRequest(job: Job, home: string, query: string,
  variables: Record<string, unknown>, transport: typeof fetch): Promise<Record<string, unknown>> {
  const token = await registryMcpProviderToken(job.connectorId, 'app.linear/linear', home, transport);
  const response = await transport('https://api.linear.app/graphql', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Linear webhook API refused (${response.status})`);
  const value = object(await response.json());
  if (!value || Array.isArray(value.errors) && value.errors.length)
    throw new Error('Linear webhook API refused the operation');
  return object(value.data) ?? {};
}

async function linearRegister(job: Job, home: string, transport: typeof fetch): Promise<Registration> {
  if (!job.signingSecret) throw new Error('Linear signing secret is missing');
  const result = await linearRequest(job, home,
    `mutation BeelineWebhookCreate($input: WebhookCreateInput!) {
       webhookCreate(input: $input) { success webhook { id enabled } }
     }`,
    { input: { id: job.id, url: job.receiverUrl, allPublicTeams: true,
      resourceTypes: ['Issue'], secret: job.signingSecret,
      label: 'Beeline issue subscription' } }, transport);
  const created = object(result.webhookCreate);
  const webhook = object(created?.webhook);
  if (created?.success !== true || webhook?.id !== job.id || webhook.enabled !== true)
    throw new Error('Linear did not enable the webhook');
  return { providerId: job.id, signingSecret: job.signingSecret };
}

async function linearRemove(job: Job, home: string, transport: typeof fetch): Promise<void> {
  if (!job.providerId) return;
  const result = await linearRequest(job, home,
    `mutation BeelineWebhookDelete($id: String!) { webhookDelete(id: $id) { success } }`,
    { id: job.providerId }, transport);
  if (object(result.webhookDelete)?.success !== true)
    throw new Error('Linear did not delete the webhook');
}

class StripeMcp {
  private readonly broker: RegistryMcpHostBroker;
  private readonly connectionId: string;
  private id = 0;
  constructor(private readonly job: Job, home: string, transport: typeof fetch) {
    // This is daemon-owned connector work supplied by the server assignment queue.
    this.broker = new RegistryMcpHostBroker(home, transport, async () => true);
    this.connectionId = `provider-webhook:${job.id}`;
  }
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const lines = await this.broker.request(this.job.connectorId,
      JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      { roomId: 'connector', requestId: this.job.id, generationId: this.connectionId },
      this.connectionId);
    for (const line of lines) {
      const message = object(parsedText(line));
      if (!message || message.id !== this.id) continue;
      if (message.error) throw new Error('Stripe MCP refused the operation');
      const result = object(message.result);
      if (result?.isError === true) throw new Error('Stripe MCP refused the operation');
      return result;
    }
    throw new Error('Stripe MCP returned no result');
  }
  async open(): Promise<void> {
    await this.call('initialize', { protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'beeline-provider-webhooks', version: '1' } });
    await this.broker.request(this.job.connectorId,
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      { roomId: 'connector', requestId: this.job.id, generationId: this.connectionId },
      this.connectionId);
  }
  async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = object(await this.call('tools/call', { name, arguments: args }));
    return result?.structuredContent ?? result?.content;
  }
}

function stripeContext(value: unknown): { stripeContext: string; livemode: boolean } {
  const choices = new Map<string, { stripeContext: string; livemode: boolean }>();
  const visit = (item: unknown, depth = 0): void => {
    if (depth > 8) return;
    const row = object(parsedText(item));
    if (row) {
      const context = row.stripe_context ?? row.stripeContext;
      if (typeof context === 'string' && typeof row.livemode === 'boolean')
        choices.set(`${context}:${row.livemode}`, { stripeContext: context, livemode: row.livemode });
      for (const child of Object.values(row)) visit(child, depth + 1);
    } else if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
  };
  visit(value);
  if (choices.size !== 1) throw new Error('Stripe must have exactly one connected account and mode');
  return [...choices.values()][0]!;
}

async function stripeRegister(job: Job, home: string, transport: typeof fetch): Promise<Registration> {
  await registryMcpProviderToken(job.connectorId, 'com.stripe/mcp', home, transport);
  const mcp = new StripeMcp(job, home, transport);
  await mcp.open();
  const tools = object(await mcp.call('tools/list', {}));
  if (!Array.isArray(tools?.tools) || !tools.tools.some((item) => object(item)?.name === 'stripe_api_write') ||
    !tools.tools.some((item) => object(item)?.name === 'list_available_accounts_or_orgs'))
    throw new Error('Stripe MCP webhook tools are unavailable');
  const context = stripeContext(await mcp.tool('list_available_accounts_or_orgs', {}));
  const result = await mcp.tool('stripe_api_write', {
    stripe_api_operation_id: 'PostWebhookEndpoints',
    stripe_context: context.stripeContext, livemode: context.livemode,
    parameters: { url: job.receiverUrl, enabled_events: [job.event],
      description: 'Beeline payment subscription' },
  });
  const endpoint = findObject(result, (row) => typeof row.id === 'string' &&
    row.id.startsWith('we_') && typeof row.secret === 'string' && row.secret.startsWith('whsec_'));
  if (!endpoint) throw new Error('Stripe did not return a signed webhook endpoint');
  return { providerId: endpoint.id as string, signingSecret: endpoint.secret as string,
    accountContext: context.stripeContext, livemode: context.livemode };
}

async function stripeRemove(job: Job, home: string, transport: typeof fetch): Promise<void> {
  if (!job.providerId || !job.accountContext || job.livemode === undefined) return;
  await registryMcpProviderToken(job.connectorId, 'com.stripe/mcp', home, transport);
  const mcp = new StripeMcp(job, home, transport);
  await mcp.open();
  const result = await mcp.tool('stripe_api_write', {
    stripe_api_operation_id: 'DeleteWebhookEndpointsWebhookEndpoint',
    stripe_context: job.accountContext, livemode: job.livemode,
    parameters: { webhook_endpoint: job.providerId },
  });
  if (!findObject(result, (row) => row.id === job.providerId && row.deleted === true))
    throw new Error('Stripe did not delete the webhook endpoint');
}

/** Provider registration stays on the helper; the server receives only the signing secret. */
export async function runProviderWebhookAssignment(job: Job, home: string,
  transport: typeof fetch = fetch): Promise<Registration | undefined> {
  if (job.service === 'linear')
    return job.operation === 'register'
      ? linearRegister(job, home, transport)
      : (await linearRemove(job, home, transport), undefined);
  return job.operation === 'register'
    ? stripeRegister(job, home, transport)
    : (await stripeRemove(job, home, transport), undefined);
}
