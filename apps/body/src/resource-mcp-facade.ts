/** Host MCP transport gate. Authorization belongs to each call, not the harness session. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { squireCallAppKeys } from '@beeline/api-contract/workbench';

export const RESOURCE_FACADE_FLAG = '--resource-mcp-facade';
export function resourceFacadeArgs(): string[] {
  const meta = import.meta.url;
  if (meta.startsWith('beeline:')) {
    if (!process.argv[1]) throw new Error('resource facade entry is unavailable');
    return [process.argv[1], RESOURCE_FACADE_FLAG];
  }
  const js = fileURLToPath(new URL('./resource-mcp-facade.js', meta));
  if (existsSync(js)) return [js];
  return [
    '--import',
    createRequire(meta).resolve('tsx'),
    fileURLToPath(new URL('./resource-mcp-facade.ts', meta)),
  ];
}

/**
 * A host declaration names its own stable resource target, and may declare
 * that its TRANSPORT — not this façade — is what spends a Once grant, when
 * the transport is itself the boundary every caller must cross (the Registry
 * broker holds the provider token and is reachable straight from a sandbox).
 * Both then ask the one server gate; exactly one of them consumes.
 */
export const MCP_RESOURCE_TARGET_KEY = 'beeline_resource_target';
export const MCP_RESOURCE_GATE_KEY = 'beeline_resource_gate';
export const MCP_RESOURCE_GATE_TRANSPORT = 'transport';

const DISCOVERY = new Set(['initialize', 'ping', 'tools/list']);
/** Discovery and notifications never spend a Once grant. */
export const NON_CONSUMING = new Set([
  ...DISCOVERY,
  'notifications/initialized',
  'notifications/cancelled',
  'notifications/progress',
  'notifications/roots/list_changed',
]);

function messageIdKey(id: unknown): string | undefined {
  if (id === undefined) return undefined;
  return JSON.stringify(id);
}

type SquireApprovalLink = {
  readonly approvalUrl: string;
  readonly approvalId?: string;
  readonly linkKind: 'approval' | 'passkey' | 'vouch';
};

export type SquireApprovalRelay = SquireApprovalLink & {
  readonly tool: string;
  readonly title: string;
  readonly detail: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function shortString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 240) : undefined;
}

function approvalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function linkKindFor(key: string, url: string): SquireApprovalLink['linkKind'] {
  const hint = `${key} ${url}`.toLowerCase();
  return hint.includes('passkey') ? 'passkey' : hint.includes('vouch') ? 'vouch' : 'approval';
}

function approvalIdIn(value: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = approvalIdIn(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const item = record(value);
  if (!item) return undefined;
  for (const [key, entry] of Object.entries(item)) {
    const normalized = key.replace(/[-_]/g, '').toLowerCase();
    if (normalized === 'approvalid') {
      const found = shortString(entry);
      if (found) return found;
    }
  }
  for (const entry of Object.values(item)) {
    const found = approvalIdIn(entry, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function approvalLinkIn(value: unknown, depth = 0): SquireApprovalLink | undefined {
  if (depth > 6) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length <= 20_000 && /^[{[]/.test(trimmed)) {
      try {
        return approvalLinkIn(JSON.parse(trimmed), depth + 1);
      } catch {
        // A prose result may still contain Squire's absolute approval link.
      }
    }
    const matches = trimmed.match(/https?:\/\/[^\s<>"']+/g) ?? [];
    for (const match of matches) {
      const url = approvalUrl(match.replace(/[),.;]+$/, ''));
      if (url && /(approv|passkey|vouch)/i.test(url)) {
        return { approvalUrl: url, linkKind: linkKindFor('', url) };
      }
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = approvalLinkIn(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const item = record(value);
  if (!item) return undefined;
  const statusHint = Object.values(item)
    .filter((entry): entry is string => typeof entry === 'string')
    .join(' ');
  for (const [key, entry] of Object.entries(item)) {
    const normalized = key.replace(/[-_]/g, '').toLowerCase();
    const namedLink = [
      'approvalurl',
      'passkeyurl',
      'vouchurl',
      'approvallink',
      'passkeylink',
      'vouchlink',
    ].includes(normalized);
    const genericPendingLink =
      ['url', 'link'].includes(normalized) && /(approv|passkey|vouch)/i.test(statusHint);
    if (!namedLink && !genericPendingLink) continue;
    const url = approvalUrl(entry);
    if (url) {
      const approvalId = approvalIdIn(item);
      return {
        approvalUrl: url,
        ...(approvalId ? { approvalId } : {}),
        linkKind: linkKindFor(key, `${statusHint} ${url}`),
      };
    }
  }
  for (const entry of Object.values(item)) {
    const found = approvalLinkIn(entry, depth + 1);
    if (found)
      return found.approvalId
        ? found
        : { ...found, ...(approvalIdIn(item) ? { approvalId: approvalIdIn(item) } : {}) };
  }
  return undefined;
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  return shortString(args[name]);
}

/** The Squire verbs that point the shared browser at a page. */
const SQUIRE_NAVIGATION_TOOLS = new Set(['operate_start', 'operate_navigate', 'operate_login']);

/**
 * The page a Squire NAVIGATION call was pointed at — its own `url` argument,
 * nothing else. It correlates an approval Squire emits later with the one
 * Registry authorization attempt whose sign-in page Squire is driving, so it
 * must not be satisfied by any URL that happens to ride some other call's
 * arguments (`use_credential`'s request url, say): that would carry a
 * `signInUrl` matching no attempt and silently skip the deduplication.
 */
export function drivenUrlIn(
  tool: string | undefined,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!tool || !SQUIRE_NAVIGATION_TOOLS.has(tool)) return undefined;
  const value = args?.url;
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function credentialLabel(args: Record<string, unknown>): string | undefined {
  return (
    stringArg(args, 'name') ??
    stringArg(args, 'label') ??
    stringArg(args, 'service') ??
    stringArg(args, 'reference')
  );
}

/** Human copy derived only from non-secret, explicitly safe Squire arguments. */
export function squireApprovalCopy(
  tool: string,
  args: Record<string, unknown>,
): { title: string; detail: string } {
  const credential = credentialLabel(args);
  const reason = stringArg(args, 'reason');
  switch (tool) {
    case 'inject_card': {
      const item = stringArg(args, 'item') ?? 'purchase';
      const merchant = stringArg(args, 'merchant');
      const amount =
        typeof args.amount_cents === 'number' && Number.isSafeInteger(args.amount_cents)
          ? `${(args.amount_cents / 100).toFixed(2)} ${String(args.currency ?? '').toUpperCase()}`.trim()
          : undefined;
      return {
        title: 'Purchase approval',
        detail: [item, merchant ? `at ${merchant}` : undefined, amount].filter(Boolean).join(' · '),
      };
    }
    case 'fetch_credential':
      return {
        title: 'Credential access approval',
        detail: [credential ? `Reveal ${credential}` : 'Reveal a saved credential', reason]
          .filter(Boolean)
          .join(' · '),
      };
    case 'edit_credential':
      return {
        title: 'Credential edit approval',
        detail: credential ? `Edit ${credential}` : 'Edit a saved credential',
      };
    case 'delete_credential':
      return {
        title: 'Credential deletion approval',
        detail: credential ? `Delete ${credential}` : 'Delete a saved credential',
      };
    case 'edit_payment_card':
      return {
        title: 'Card edit approval',
        detail: credential ? `Edit ${credential}` : 'Edit a saved payment card',
      };
    case 'operate_fill_credential':
    case 'operate_login':
      return {
        title: 'Sign-in approval',
        detail: [credential ? `Sign in to ${credential}` : 'Continue a secure sign-in', reason]
          .filter(Boolean)
          .join(' · '),
      };
    default:
      return {
        title: 'Trusty Squire approval',
        detail: reason ?? `Approve ${tool.replace(/_/g, ' ')}`,
      };
  }
}

/** A Squire MCP result exposes pending human work through its approval URL. */
export function squireApprovalFromMcp(
  request: Record<string, unknown> | undefined,
  response: Record<string, unknown>,
): SquireApprovalRelay | undefined {
  if (!request || request.method !== 'tools/call' || request.id !== response.id) return undefined;
  const params = record(request.params);
  const tool = shortString(params?.name);
  if (!tool || !('result' in response)) return undefined;
  const link = approvalLinkIn(response.result);
  if (!link) return undefined;
  const args = record(params?.arguments) ?? {};
  return { tool, ...squireApprovalCopy(tool, args), ...link };
}

async function postSquireApproval(
  approval: SquireApprovalRelay,
  authFile: string,
  signInUrl?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const auth = JSON.parse(await readFile(authFile, 'utf8')) as {
    baseUrl: string;
    daemonToken: string;
    turnContextPath: string;
  };
  const context = JSON.parse(await readFile(auth.turnContextPath, 'utf8')) as Record<
    string,
    unknown
  >;
  if (
    ![context.roomId, context.requestId, context.generationId].every(
      (value) => typeof value === 'string' && value.length > 0,
    )
  )
    return;
  await fetchImpl(new URL('/v1/daemon/operations/postSquireApproval', auth.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.daemonToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...context, ...approval, ...(signInUrl ? { signInUrl } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
}

/**
 * What the server's gate needs to know about one call beyond its target: the
 * tool it runs, for the app usage ledger, and — for Trusty Squire — the apps
 * its arguments name, so a Squire call for a connected app answers to that
 * app's one permission decision rather than Squire's own.
 */
export function resourceCallFacts(
  message: Record<string, unknown>,
  target: string,
): { operation?: string; appKeys?: readonly string[] } {
  if (message.method !== 'tools/call') return {};
  const params = record(message.params);
  const tool = shortString(params?.name);
  const appKeys = target === 'squire' ? squireCallAppKeys(record(params?.arguments)) : [];
  return {
    ...(tool ? { operation: tool } : {}),
    ...(appKeys.length ? { appKeys } : {}),
  };
}

export async function authorizeResourceMessage(
  message: Record<string, unknown>,
  target: string,
  authFile: string,
  spendsGrant = true,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!message || Array.isArray(message) || typeof message !== 'object') return false;
  if (typeof message.method !== 'string') return false;
  const auth = JSON.parse(await readFile(authFile, 'utf8')) as {
    baseUrl: string;
    daemonToken: string;
    turnContextPath: string;
  };
  const context = JSON.parse(await readFile(auth.turnContextPath, 'utf8')) as Record<
    string,
    unknown
  >;
  if (
    ![context.roomId, context.requestId, context.generationId].every(
      (value) => typeof value === 'string' && value.length > 0,
    )
  )
    return false;
  const response = await fetchImpl(
    new URL('/v1/daemon/operations/authorizeResourceCall', auth.baseUrl),
    {
      method: 'POST',
      headers: { authorization: `Bearer ${auth.daemonToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...context,
        target,
        ...(spendsGrant && !NON_CONSUMING.has(message.method) ? {} : { consume: false }),
        ...resourceCallFacts(message, target),
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  return response.ok && ((await response.json()) as { allowed?: boolean }).allowed === true;
}

export function runResourceFacade(env: NodeJS.ProcessEnv = process.env): void {
  const target = env.BEELINE_RESOURCE_TARGET;
  const authFile = env.BEELINE_RESOURCE_AUTH_FILE;
  const spendsGrant = env.BEELINE_RESOURCE_GATE !== MCP_RESOURCE_GATE_TRANSPORT;
  if (!target || !authFile || !env.BEELINE_RESOURCE_LAUNCH)
    throw new Error('resource route authorization is unavailable');
  const launch = JSON.parse(env.BEELINE_RESOURCE_LAUNCH) as {
    command?: string;
    cmd?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    envs?: Record<string, string>;
  };
  const childEnv = { ...env, ...launch.env, ...launch.envs };
  delete childEnv.BEELINE_RESOURCE_LAUNCH;
  delete childEnv.BEELINE_RESOURCE_AUTH_FILE;
  const command = launch.command ?? launch.cmd;
  if (!command && !launch.url) throw new Error('resource transport is unavailable');
  const squireRequests = new Map<
    string,
    { message: Record<string, unknown>; drivenUrl?: string }
  >();
  let activeSquireBrowserUrl: string | undefined;
  const observeSquireResponse = async (message: Record<string, unknown>) => {
    if (target !== 'squire' || message.id === undefined) return;
    const key = JSON.stringify(message.id);
    const request = squireRequests.get(key);
    squireRequests.delete(key);
    const approval = squireApprovalFromMcp(request?.message, message);
    if (approval) {
      await postSquireApproval(approval, authFile, request?.drivenUrl).catch(() => {});
      if (request?.drivenUrl && activeSquireBrowserUrl === request.drivenUrl)
        activeSquireBrowserUrl = undefined;
    }
  };
  const authorizedResponseIds = new Set<string>();
  let child: ReturnType<typeof spawn> | undefined;
  let responsePending = Promise.resolve();
  const resourceChild = () => {
    if (child) return child;
    const started = spawn(command!, launch.args ?? [], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    child = started;
    const output = createInterface({ input: started.stdout });
    output.on('line', (line) => {
      responsePending = responsePending.then(async () => {
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          const key = messageIdKey(message.id);
          if (!key || !authorizedResponseIds.delete(key)) return;
          await observeSquireResponse(message);
          process.stdout.write(`${line}\n`);
        } catch {
          // Personal-resource output is visible only as a correlated JSON-RPC response.
        }
      });
    });
    started.on('error', () => {
      process.exitCode = 1;
      process.stdin.destroy();
    });
    started.on('exit', (code) => {
      process.exitCode = code ?? 1;
      process.stdin.destroy();
    });
    return started;
  };
  let session: string | undefined;
  const lines = createInterface({ input: process.stdin });
  // Serialize calls so Once cannot be used by two requests before consumption.
  let pending = Promise.resolve();
  lines.on('line', (line) => {
    pending = pending.then(async () => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      try {
        if (!(await authorizeResourceMessage(message, target, authFile, spendsGrant)))
          throw new Error('resource approval required');
        if (target === 'squire' && message.method === 'tools/call') {
          const call = record(message.params);
          const tool = shortString(call?.name);
          const navigationUrl = drivenUrlIn(tool, record(call?.arguments));
          activeSquireBrowserUrl =
            navigationUrl ??
            (tool?.startsWith('operate_') && !SQUIRE_NAVIGATION_TOOLS.has(tool)
              ? activeSquireBrowserUrl
              : undefined);
          if (message.id !== undefined)
            squireRequests.set(JSON.stringify(message.id), {
              message,
              ...(activeSquireBrowserUrl ? { drivenUrl: activeSquireBrowserUrl } : {}),
            });
        }
        if (command) {
          const started = resourceChild();
          const key = messageIdKey(message.id);
          if (key) authorizedResponseIds.add(key);
          started.stdin!.write(`${line}\n`);
          return;
        }
        const response = await fetch(launch.url!, {
          method: 'POST',
          headers: {
            ...launch.headers,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(session ? { 'mcp-session-id': session } : {}),
          },
          body: line,
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error('resource transport refused the call');
        session = response.headers.get('mcp-session-id') ?? session;
        if (response.status === 202 || response.status === 204) return;
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          const expectedId = messageIdKey(message.id);
          if (!expectedId) return;
          const reader = response.body?.getReader();
          if (!reader) return;
          let buffer = '';
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              let end: number;
              while ((end = buffer.indexOf('\n')) >= 0) {
                const row = buffer.slice(0, end).trimEnd();
                buffer = buffer.slice(end + 1);
                if (!row.startsWith('data:')) continue;
                const data = row.slice(5).trim();
                const result = JSON.parse(data) as { id?: unknown };
                if (messageIdKey(result.id) !== expectedId) continue;
                await observeSquireResponse(result as Record<string, unknown>);
                process.stdout.write(`${data}\n`);
                return;
              }
            }
          } finally {
            await reader.cancel();
          }
        } else {
          const body = await response.text();
          if (body) {
            const result = JSON.parse(body) as { id?: unknown };
            const expectedId = messageIdKey(message.id);
            if (!expectedId || messageIdKey(result.id) !== expectedId)
              throw new Error('resource transport returned an unrelated response');
            await observeSquireResponse(result as Record<string, unknown>);
            process.stdout.write(`${body}\n`);
          }
        }
      } catch {
        if (message.id !== undefined)
          process.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Resource access requires approval from its owner for this requester, or the resource is unavailable.' } })}\n`,
          );
      }
    });
  });
  lines.on('close', () => {
    void pending.finally(() => child?.stdin?.end());
  });
  process.on('SIGTERM', () => {
    child?.kill();
    process.exit();
  });
}

if (/resource-mcp-facade\.(?:js|ts)$/.test(process.argv[1] ?? '')) runResourceFacade();
