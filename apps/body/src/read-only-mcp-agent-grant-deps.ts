import { type SecretResolver, operatorSecretResolver, storeOperatorSecret } from "./grant-runner.js";
import { type CommandGrantRule, type CommandGrantScript, interpreterScriptArgument, GRANT_SCRIPT_MAX_BYTES, GRANT_SCRIPT_MAX_LINES, grantScriptTooLongMessage, isRequestableAgentGrantKind, REQUESTABLE_AGENT_GRANT_KINDS, AGENT_GRANT_TARGET_MAX_LENGTH, parseCommandGrantTarget, AGENT_GRANT_REASON_MAX_LENGTH, HOST_EMULATOR_TARGET, AGENT_GRANT_VERBS, type AgentGrantEscalation, formatGrantEscalationReason, isSharedAssetCategory, SHARED_ASSET_CATEGORIES, COMMAND_SECRET_NAME } from "@beeline/api-contract/agent-grants";
import { resolveGrantCommand, resolveGrantScriptExecutable, isNativeGrantExecutable } from "./grant-script.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostEmulatorSerials } from "./machine-control.js";
import { sandboxDevicePath } from "./bwrap-sandbox.js";
import { findChromiumPage } from "./browser-share.js";
import { startHostedBrowserShare } from "./browser-share-host.js";
import { isOfferableConnectorKind, OFFERABLE_CONNECTOR_KINDS, CONNECTOR_OFFER_REASON_MAX_LENGTH } from "@beeline/api-contract/connector-offers";
import { JsonObject, daemonExecute, stringArg, asObject, activeCommandContext, squireShareEndpoint, requiredEnv, connectorOfferDepsFromEnv } from './read-only-mcp.js';
import { agentScheduleRoomId, resolveAttachPath } from './read-only-mcp-download-attachment.js';









export interface AgentGrantDeps {
  roomId: string;
  execute: (name: string, input: JsonObject) => Promise<JsonObject>;
  /** Where a script argument may be read from: the checkout, then the scratch. */
  scriptRoots?: string[];
  /** Execution environment used to resolve bare executable names. */
  scriptEnv?: NodeJS.ProcessEnv;
  /** Test seam for reading those bytes. */
  readScript?: (path: string) => Buffer;
  /** Read-only probe of the already running host adb server. */
  hostEmulators?: () => Promise<string[]>;
  /**
   * Where a command grant's named secrets resolve from, at ask time and for
   * `list_grants`. Defaults to the operator key store, secrets.json, then the
   * daemon environment.
   */
  resolveSecret?: SecretResolver;
  /** Where `store_secret` writes; defaults to the daemon's secrets.json. */
  storeSecret?: (name: string, value: string) => Promise<void>;
}




export function agentGrantDepsFromEnv(): AgentGrantDeps {
  const scratchRoot = process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim();
  const attachRoot = process.env.BEELINE_ATTACH_ROOT?.trim();
  return {
    roomId: agentScheduleRoomId(),
    execute: daemonExecute,
    scriptRoots: [...(attachRoot ? [attachRoot] : []), ...(scratchRoot ? [scratchRoot] : [])],
    resolveSecret: operatorSecretResolver(process.env),
    storeSecret: (name, value) => storeOperatorSecret(name, value, process.env),
  };
}




/**
 * The script an interpreter command will run, read so the approval card can
 * SHOW it (C94).
 *
 * `python3 fix.py` tells the person deciding nothing about what runs, so the
 * bytes travel with the ask and the approval is bound to their hash. A file too
 * long to read on a card is REFUSED, never truncated — an honest card is the
 * whole point, and a body that size belongs in a corner as a branch and a pull
 * request. A line with no script argument (`python3 -V`) has nothing to bind;
 * it still asks a human, because the interpreter class is never covered by yolo.
 */
export function readGrantScript(
  rule: CommandGrantRule,
  deps: AgentGrantDeps,
): CommandGrantScript | undefined {
  const roots = deps.scriptRoots ?? [];
  if (!roots.length) return undefined;
  const context = resolveGrantCommand(rule.argv, roots[0]!, deps.scriptEnv ?? process.env);
  const argument = interpreterScriptArgument(context.argv, true);
  if (!argument) return undefined;
  const candidatePath = resolveGrantScriptExecutable(argument, context.cwd, context.env);
  const executable = argument.direct ? candidatePath : undefined;
  if (argument.direct && !executable) return undefined;
  if (argument.direct) {
    // Native executable paths do not need a script card, including binaries
    // outside the attachment roots. Script paths still meet the root check below.
    let candidate: Buffer;
    try {
      candidate = (deps.readScript ?? readFileSync)(executable!);
    } catch { return undefined; }
    if (isNativeGrantExecutable(candidate)) return undefined;
  }
  let resolved: string;
  try {
    resolved = resolveAttachPath(roots, candidatePath ?? argument.path);
  } catch (error) {
    // A script that exists but sits outside the checkout and the scratch cannot
    // be put in front of a human, so it is not approvable from here.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('outside')) {
      throw new Error(
        `${argument.path} is outside your checkout and scratch directory, so its contents ` +
          'cannot be shown on the approval card. Move the script into your checkout or scratch, ' +
          'or open a corner with open_corner and make the change there.',
      );
    }
    return undefined;
  }
  const bytes = (deps.readScript ?? readFileSync)(resolved);
  // Direct native executables retain ordinary command grant behavior.
  if (argument.direct && isNativeGrantExecutable(bytes)) return undefined;
  const contents = bytes.toString('utf8');
  const lines = contents.split('\n').length;
  if (bytes.byteLength > GRANT_SCRIPT_MAX_BYTES || lines > GRANT_SCRIPT_MAX_LINES) {
    throw new Error(grantScriptTooLongMessage(argument.path, bytes.byteLength, lines));
  }
  if (!Buffer.from(contents, 'utf8').equals(bytes)) {
    throw new Error(
      `${argument.path} is not text, so nobody can read what it does on an approval card. ` +
        'Open a corner with open_corner and make the change there.',
    );
  }
  return {
    path: argument.path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    contents,
  };
}




/** request_grant: one ask, one kind, one target; the server decides yolo vs card. */
export async function requestGrant(
  args: JsonObject,
  deps: AgentGrantDeps = agentGrantDepsFromEnv(),
): Promise<string> {
  const purpose = stringArg(args, 'purpose')?.trim();
  if (!purpose || purpose.length > 240) throw new Error('purpose is required: explain what you want to do and why in 1–240 characters');
  const kind = stringArg(args, 'kind');
  if (kind === 'shared_asset') {
    if (args.ttl !== undefined) throw new Error('shared asset isolation must be standing');
    return requestSharedAssetIsolation({ category: args.target, reason: args.reason, purpose: args.purpose, touches: args.touches, capabilities: args.capabilities }, deps);
  }
  if (!isRequestableAgentGrantKind(kind)) {
    throw new Error(`kind must be one of ${REQUESTABLE_AGENT_GRANT_KINDS.join(', ')}`);
  }
  const rawTarget = stringArg(args, 'target');
  const target = kind === 'command' ? (rawTarget ?? '') : (rawTarget ?? '').trim();
  if (!target) throw new Error('target must be a non-empty string');
  if (target.length > AGENT_GRANT_TARGET_MAX_LENGTH) throw new Error('target is too long');
  const rule = kind === 'command' ? parseCommandGrantTarget(target) : undefined;
  const script = rule ? readGrantScript(rule, deps) : undefined;
  const reason = stringArg(args, 'reason')?.trim();
  if (!reason) throw new Error('reason must be a non-empty string');
  if (reason.length > AGENT_GRANT_REASON_MAX_LENGTH) throw new Error('reason is too long');
  const ttl = args.ttl;
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 60)) {
    throw new Error('ttl must be an integer number of seconds, at least 60');
  }
  // Reject at ask time a command grant whose named secrets cannot resolve: an
  // approved grant that fails at run time is the failure this whole fix removes.
  // Resolvable means the operator key store, secrets.json, or the daemon's own
  // environment has a value for the name, now.
  if (kind === 'command' && rule && rule.secrets.length) {
    const resolveSecret = deps.resolveSecret ?? operatorSecretResolver(process.env);
    const missing: string[] = [];
    for (const name of rule.secrets) {
      if (!(await resolveSecret(name))) missing.push(name);
    }
    if (missing.length) {
      throw new Error(
        `secret ${missing.join(', ')} is not in the operator key store or the daemon environment, so this command grant could never run. ` +
          'Have the operator initialize the named secret securely, or drop the --with suffix.',
      );
    }
  }
  if (kind === 'host' && target === HOST_EMULATOR_TARGET) {
    const listed = await deps.execute('listAgentGrants', { roomId: deps.roomId });
    const live = Array.isArray(listed.grants) ? listed.grants.map(asObject) : [];
    const grant = live.find((entry) => entry.kind === kind && entry.target === target &&
      (entry.status === 'approved' || entry.status === 'once'));
    if (grant) {
      let serials: string[];
      try { serials = await (deps.hostEmulators ?? hostEmulatorSerials)(); }
      catch { serials = []; }
      if (!serials.length)
        return 'Host emulator unavailable: no running host emulator is available; nothing was started. Do not use an emulator and say so in your reply.';
      if (grant.status === 'once')
        await deps.execute('consumeAgentGrant', { grantId: grant.grantId });
      return `Host emulator allowed at ${target}: ${serials.map((serial) => `adb -H 127.0.0.1 -P 5037 -s ${serial}`).join('; ')}. Use this existing emulator only; the helper never starts or manages it.`;
    }
    const history = await deps.execute('listAgentGrantRequests', { roomId: deps.roomId });
    const requests = Array.isArray(history.grants) ? history.grants.map(asObject) : [];
    const previous = requests.find((entry) => !entry.agentId && entry.kind === kind && entry.target === target);
    if (previous?.status === 'denied' || previous?.status === 'revoked')
      return 'Host emulator permission refused: do not use an emulator and say so in your reply.';
    if (previous?.status === 'pending')
      return 'Host emulator permission pending: wait for the host to Allow, then call request_grant again for the existing emulator address; end your turn now without using an emulator.';
  }
  const result = await deps.execute('requestAgentGrant', {
    roomId: deps.roomId,
    kind,
    target,
    reason,
    purpose,
    ...(args.touches !== undefined ? { touches: stringArg(args, 'touches') } : {}),
    ...(args.capabilities !== undefined ? { capabilities: stringArg(args, 'capabilities') } : {}),
    ...(ttl !== undefined ? { ttlSeconds: ttl } : {}),
    ...(script ? { script } : {}),
  });
  const grantId = typeof result.grantId === 'string' ? result.grantId : 'unknown';
  const ask = `${AGENT_GRANT_VERBS[kind]} ${target}`;
  if (result.auto === true) {
    if (kind === 'command')
      return `approved: ${ask} [grant ${grantId}]. Run it now with run_granted_command and the argv.`;
    if (kind === 'device') {
      // bwrap fixes /dev when a session starts, so the turn loop continues
      // this same turn in a fresh session that has it (`approvedDeviceGrant`).
      return sandboxDevicePath(target)
        ? `approved: ${ask} [grant ${grantId}]. A running session cannot add a device, so end your turn now with one short line; this same turn continues straight away in a session that has ${target}. Do not ask anyone to restart.`
        : `approved: ${ask} [grant ${grantId}], but only device nodes under /dev/ are added to your session, so nothing was added.`;
    }
    return `approved: ${ask} [grant ${grantId}]; applies at the agent's next session.`;
  }
  // Yolo covers most asks; these two shapes never do, and saying which one this
  // is stops the model retrying the same line expecting a different answer.
  const escalations = Array.isArray(result.escalations)
    ? (result.escalations as AgentGrantEscalation[])
    : [];
  const because = formatGrantEscalationReason(escalations);
  const approval = asObject(result.approval);
  const authority =
    approval.authority === 'workspace-manager'
      ? 'A Workspace owner or admin'
      : approval.authority === 'resource-owner'
        ? 'The resource owner'
        : 'An authorized person';
  const destination =
    approval.destination === 'room'
      ? 'on the card in this Room'
      : approval.destination === 'trusty-squire-dm'
        ? "in the resource owner's private Trusty Squire DM"
        : approval.destination === 'wallet-dm'
          ? "in the resource owner's private Wallet DM"
          : approval.destination === 'system-dm'
            ? "in the resource owner's private @system DM"
            : 'on the approval card';
  return (
    `pending, card posted: ${ask} [grant ${grantId}]. ` +
    (because ? `A human always answers this one because ${because}. ` : '') +
    (script
      ? `The card shows ${script.path} in full, and the approval is bound to those bytes. `
      : '') +
    `${authority} must answer ALWAYS, ONCE, or NO ${destination}; ` +
    'your turn is paused on this grant. Tell the human what you are waiting for and end your turn now; ' +
    (kind === 'mcp'
      ? 'the approval wake starts the fresh session with that route mounted, so use it immediately without restarting or scheduling another turn.'
      : 'you will be woken with the answer.')
  );
}




export async function requestSharedAssetIsolation(
  args: JsonObject,
  deps: AgentGrantDeps = agentGrantDepsFromEnv(),
): Promise<string> {
  const purpose = stringArg(args, 'purpose')?.trim();
  if (!purpose || purpose.length > 240) throw new Error('purpose is required: explain what you want to do and why in 1–240 characters');
  const category = stringArg(args, 'category');
  if (!isSharedAssetCategory(category))
    throw new Error(`category must be one of ${SHARED_ASSET_CATEGORIES.join(', ')}`);
  const reason = stringArg(args, 'reason')?.trim();
  if (!reason || reason.length > AGENT_GRANT_REASON_MAX_LENGTH)
    throw new Error('reason must explain the failure in at most 1000 characters');
  const result = await deps.execute('requestAgentGrant', {
    roomId: deps.roomId, kind: 'shared_asset', target: category, reason, purpose,
    ...(args.touches !== undefined ? { touches: stringArg(args, 'touches') } : {}),
    ...(args.capabilities !== undefined ? { capabilities: stringArg(args, 'capabilities') } : {}),
  });
  if (result.status !== 'pending' || result.auto !== false)
    throw new Error('shared asset isolation did not open a human approval');
  return `pending, card posted: isolate ${category} [grant ${String(result.grantId)}]. A Workspace owner, admin, or this agent's owner must answer ALWAYS or NO on the card in this Room. Your turn is paused; end it now. If approved, the category becomes private from your next session.`;
}




/**
 * list_grants: every grant this agent raised — pending, approved, and once —
 * with status, target, reason, and, for a command grant, whether each named
 * secret currently resolves. This is inspection, never authority: it changes
 * no state. Corner reviewers may also inspect that corner implementer's rows.
 */
export async function listGrants(
  deps: AgentGrantDeps = agentGrantDepsFromEnv(),
): Promise<string> {
  const result = (await deps.execute('listAgentGrantRequests', {
    roomId: deps.roomId,
  })) as { grants?: Array<Record<string, unknown>> };
  const grants = Array.isArray(result.grants) ? result.grants : [];
  if (!grants.length) {
    return 'no grants right now: nothing pending an answer, approved, or spent-once';
  }
  const resolveSecret = deps.resolveSecret ?? operatorSecretResolver(process.env);
  const lines: string[] = [];
  for (const entry of grants) {
    const grantId = typeof entry.grantId === 'string' ? entry.grantId : 'unknown';
    const kind = typeof entry.kind === 'string' ? entry.kind : 'unknown';
    const status = typeof entry.status === 'string' ? entry.status : 'unknown';
    const target = typeof entry.target === 'string' ? entry.target : '';
    const reason = typeof entry.reason === 'string' ? entry.reason : '';
    let secretsNote = '';
    if (kind === 'command') {
      try {
        const rule = parseCommandGrantTarget(target);
        if (rule.secrets.length) {
          const missing = (
            await Promise.all(
              rule.secrets.map(async (name) => ((await resolveSecret(name)) ? null : name)),
            )
          ).filter((name): name is string => name !== null);
          secretsNote = missing.length
            ? ` · secrets ${missing.join(', ')} NOT resolvable (operator secret setup is required before asking again)`
            : ` · secrets present`;
        }
      } catch {
        // A target that no longer parses is shown plainly; nothing else to say.
      }
    }
    lines.push(`- ${status} ${kind} ${target} [${grantId}]${typeof entry.agentId === 'string' ? ` · agent ${entry.agentId}` : ''}${reason ? ` · ${reason}` : ''}${secretsNote}`);
  }
  return ['grants:', ...lines].join('\n');
}




/**
 * store_secret: write one operator secret by name so a command grant's
 * `--with NAME` resolves at run time. The value goes into the daemon's
 * secrets.json (mode 0600) and is never echoed, never sent to the server, and
 * never shown on a ledger row.
 */
export async function storeSecret(
  args: JsonObject,
  deps: AgentGrantDeps = agentGrantDepsFromEnv(),
): Promise<string> {
  const name = stringArg(args, 'name')?.trim();
  const value = args.value;
  if (!name || !COMMAND_SECRET_NAME.test(name)) {
    throw new Error('name must be one UPPER_CASE secret name (A-Z, 0-9, underscore, max 64 chars)');
  }
  if (typeof value !== 'string' || !value) {
    throw new Error('value must be a non-empty string');
  }
  if (value.length > 8192) {
    throw new Error('value is too long: secrets are capped at 8192 characters');
  }
  await (deps.storeSecret ?? ((n, v) => storeOperatorSecret(n, v)))(name, value);
  return `stored secret ${name} in the operator key store; it now resolves for --with ${name}. The value was never echoed.`;
}




export interface ConnectorOfferDeps {
  roomId: string;
  execute: (name: string, input: JsonObject) => Promise<JsonObject>;
  /** Live Tailscale reachability; `enabled` is true when this helper already has it. */
  tailscaleReach?: (enabled: boolean) => Promise<string>;
  squireReach?: () => Promise<{ reachable: boolean; cause?: string } | undefined>;
  /** One Squire tool call through this agent's task relay; returns the parsed text result. */
  squireCall?: (tool: string, args?: Record<string, unknown>) => Promise<unknown>;
}




/**
 * Squire error codes with a known recovery. Codes come from Squire's
 * `errorContent` ({ error: { code, message } }): `stale_lease` and
 * `unknown_session` mean the session is gone or not this connection's, and the
 * Beeline task relay reuses `stale_lease` for the same case.
 */
export const SQUIRE_SHARE_CAUSES: Record<string, string> = {
  stale_lease: 'the Squire browser session is gone or no longer owned by this conversation; call operate_start for a fresh session, then share it',
  unknown_session: 'the Squire browser session is gone; call operate_start for a fresh session, then share it',
  session_busy: 'cancelled work still holds this Squire session; wait for it to settle or call operate_finish',
  server_unavailable: 'the Squire browser service is unavailable; do not restart it, try again later',
};




/** Messages the Beeline task relay writes itself, so they hold no provider text. */
export const SQUIRE_RELAY_REFUSALS = new Set([
  'Squire MCP connection died and its browser session is gone; call operate_start',
  'Squire browser session is no longer owned by this conversation; call operate_start',
  'Squire MCP connection died; call operate_start for a fresh browser session',
  'Squire call is not authorized for this task',
  'Squire requires the current active task',
  'Squire task ended while the call was running',
]);




/** Only known causes reach the agent; provider payloads may hold secrets. */
export function squireShareFailure(status: number, body: unknown): Error {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (typeof record.error === 'string' && SQUIRE_RELAY_REFUSALS.has(record.error))
    return new Error(`Squire could not share this browser session: ${record.error}`);
  const result = record.result as { content?: Array<{ type?: string; text?: unknown }> } | undefined;
  const text = Array.isArray(result?.content)
    ? result.content.find((entry) => entry?.type === 'text')?.text : undefined;
  let code: unknown;
  try { code = (JSON.parse(typeof text === 'string' ? text : '') as { error?: { code?: unknown } }).error?.code; }
  catch { /* Unstructured text stays private. */ }
  if (typeof code === 'string' && Object.hasOwn(SQUIRE_SHARE_CAUSES, code))
    return new Error(`Squire could not share this browser session: ${SQUIRE_SHARE_CAUSES[code]} (${code})`);
  const safeCode = typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? `, code ${code}` : '';
  return new Error(`Squire share failed (HTTP ${status}${safeCode})`);
}




export async function shareBrowser(args: JsonObject): Promise<string> {
  const startedAt = Date.now();
  console.error(`[computer-share] tool started source=${String(args.source ?? 'unknown')} at=${new Date(startedAt).toISOString()}`);
  const context = await activeCommandContext();
  const title = typeof args.title === 'string' ? args.title : 'Browser';
  if (args.source === 'squire') {
    if (typeof args.sessionId !== 'string' || !args.sessionId.trim())
      throw new Error('An existing Squire operate session id is required');
    const { url: upstreamUrl, expiresAt } = await squireShareEndpoint(args.sessionId);
    console.error(`[computer-share] Squire operate_share completed ms=${Date.now() - startedAt}`);
    const result = await daemonExecute('postComputerSession', {
      roomId: context.roomId, sessionId: args.sessionId, upstreamUrl, title, expiresAt,
    });
    console.error(`[computer-share] card published ms=${Date.now() - startedAt}`);
    return JSON.stringify({ cardId: result.messageId, shareId: result.id, message: 'The live browser card is posted in this place. Ask the person to open the card.', sessionId: args.sessionId, status: 'live' });
  }
  if (args.source !== 'chromium') throw new Error('Choose an open Squire or Chromium browser');
  const debugUrl = typeof args.debugUrl === 'string' ? args.debugUrl : 'http://127.0.0.1:9222';
  const target = typeof args.target === 'string' ? args.target : undefined;
  const page = await findChromiumPage(debugUrl, target);
  const result = await daemonExecute('postComputerSession', {
    roomId: context.roomId, sessionId: page.id, upstreamUrl: 'body:', title: args.title ?? page.title ?? 'Browser',
  });
  console.error(`[computer-share] card published ms=${Date.now() - startedAt}`);
  try {
    await startHostedBrowserShare(requiredEnv('BEELINE_BROWSER_SHARE_HOST_SOCKET'), {
      page, shareId: String(result.id), roomId: context.roomId,
      serverBaseUrl: requiredEnv('BEELINE_DAEMON_BASE_URL'),
      daemonToken: requiredEnv('BEELINE_DAEMON_TOKEN'),
    });
  } catch (error) {
    await daemonExecute('endComputerSession', { roomId: context.roomId, sessionId: page.id });
    throw error;
  }
  return JSON.stringify({ cardId: result.messageId, shareId: result.id, message: 'The live browser card is posted in this place. Ask the person to open the card.', sessionId: page.id, status: 'live' });
}





/**
 * workbench_status: the Workbench of the machine and owner this helper
 * actually runs on, rendered as text the model reads line by line — a tool
 * it may offer, a tool already paired (and where), a connection by name.
 */
export async function workbenchStatus(
  deps: ConnectorOfferDeps = connectorOfferDepsFromEnv(),
): Promise<string> {
  const view = (await deps.execute('readAgentWorkbench', { roomId: deps.roomId })) as {
    addressee?: { name?: string; handle?: string };
    owner?: { name?: string; handle?: string };
    catalog?: Array<{
      connectorType: string;
      name: string;
      purpose: string;
      available: boolean;
      offerable: boolean;
      paired?: { status: string; helperName: string; onThisMachine: boolean;
        errorMessage?: string };
    }>;
    connections?: Array<{
      connectorType: string;
      service: string | null;
      label: string;
      state: string;
    }>;
    apps?: Array<{ appId: string; appKey: string; name: string; transport: string; connectionReference?: string;
      status: string; errorMessage?: string }>;
    firstPartyIntegrations?: Array<{ key: string; name: string; status: string }>;
    machine?: { machineId: string; name: string;
      squire?: { status: 'connected' | 'error' | 'not-added'; errorMessage?: string } };
  };
  const who = view.owner?.handle
    ? `@${view.owner.handle}`
    : (view.owner?.name ??
      (view.addressee?.handle
        ? `@${view.addressee.handle}`
        : (view.addressee?.name ?? 'the owner of this machine')));
  const machine = view.machine?.name ?? 'this machine';
  const lines = [
    `Connectors for ${who} on ${machine} (this is the machine you run on; an accepted offer installs here).`,
    '',
    'Catalog:',
  ];
  const machineReport = view.machine?.squire;
  const squireReach = deps.squireReach
    ? await deps.squireReach()
    : machineReport && machineReport.status !== 'not-added'
      ? { reachable: machineReport.status === 'connected', cause: machineReport.errorMessage }
      : undefined;
  for (const entry of view.catalog ?? []) {
    const localReach = entry.connectorType === 'trusty-squire'
      ? squireReach : undefined;
    if (entry.connectorType === 'trusty-squire') {
      const state = localReach
        ? `${localReach.reachable ? 'connected' : 'error'} on ${machine} (your machine)${localReach.cause ? ` — ${localReach.cause}` : ''}`
        : 'not added';
      lines.push(`- ${entry.connectorType} (${entry.name}): ${state}. ${entry.purpose}`);
      continue;
    }
    const status = entry.paired?.status;
    const cause = status === 'error'
      ? entry.paired?.errorMessage ?? 'Connection failed'
      : undefined;
    const state = entry.paired
      ? `${status} on ${entry.paired.helperName}${entry.paired.onThisMachine ? ' (your machine)' : ''}${cause ? ` — ${cause}` : ''}`
      : !entry.available
        ? 'not available yet'
        : 'not added — call connect';
    lines.push(`- ${entry.connectorType} (${entry.name}): ${state}. ${entry.purpose}`);
  }
  lines.push('', 'Connections (keys already provisioned, by name only):');
  const connections = view.connections ?? [];
  if (!connections.length) lines.push('- none');
  for (const connection of connections)
    lines.push(
      `- ${connection.label}${connection.service ? ` (${connection.service})` : ''} via ${connection.connectorType}${connection.state === 'error' ? ' — in error' : ''}`,
    );
  lines.push('', 'Apps (connect; each use is authorized as app:<key>):');
  for (const integration of view.firstPartyIntegrations ?? [])
    lines.push(`- ${integration.name} (${integration.key}) via Beeline: ${integration.status}`);
  const apps = view.apps ?? [];
  if (!apps.length) lines.push('- none');
  for (const app of apps)
    lines.push(`- ${app.name} (app:${app.appKey}, id ${app.appId}) via ${app.transport}: ${app.status}${app.transport === 'squire-api' && app.connectionReference ? `; use_credential(reference:${JSON.stringify(app.connectionReference)})` : ''}${app.status === 'error' && app.errorMessage ? ` — ${app.errorMessage}` : ''}`);
  const github = apps.find(app => app.appKey === 'github' && app.status !== 'disconnected');
  if (github) {
    const route = github.transport === 'squire-api'
      ? `call Squire use_credential (${github.connectionReference ? `reference ${JSON.stringify(github.connectionReference)}` : 'service "github"'})`
      : `use app_tool(app:"${github.appId}")`;
    lines.push('', `GitHub operation identity: in Room, corner and DM sessions, use the Beeline GitHub App for linked-repository code, branch and PR writes, including Git Data API pushes, even when personal GitHub is connected. Without an App checkout, use a corner of the linked Room. This owner's personal GitHub connection (app ${github.appId}, ${github.transport}) serves general lookups, repositories without App access and person-scoped actions; ${route}. Report denials with the exact error and route. Never fall back from App to personal for linked-repository writes or retry person-scoped actions as the App. A mistaken personal-route denial on a linked-repository write does not prevent using the authorized App route. Consult beeline-connecting-services for checkout and merge boundaries.`);
  }
  if (deps.tailscaleReach) {
    const enabled = Boolean(
      view.catalog?.some(
        (entry) =>
          entry.connectorType === 'tailscale' &&
          entry.paired &&
          entry.paired.onThisMachine &&
          entry.paired.status !== 'disconnected',
      ),
    );
    lines.push('', await deps.tailscaleReach(enabled));
  }
  return lines.join('\n');
}




/**
 * offer_connector: one card, one tool, the turn paused on it. The server
 * owns the card's consequence line; the agent supplies only its reason.
 */
export async function offerConnector(
  args: JsonObject,
  deps: ConnectorOfferDeps = connectorOfferDepsFromEnv(),
): Promise<string> {
  const connectorType = stringArg(args, 'connectorType');
  if (!isOfferableConnectorKind(connectorType)) {
    throw new Error(
      `connectorType must be one of ${OFFERABLE_CONNECTOR_KINDS.join(', ')} (see connectors_status)`,
    );
  }
  const reason = stringArg(args, 'reason')?.trim().replace(/\s+/g, ' ');
  if (!reason) throw new Error('reason must be a non-empty string');
  if (reason.length > CONNECTOR_OFFER_REASON_MAX_LENGTH) throw new Error('reason is too long');
  const intent = stringArg(args, 'intent');
  if (intent !== undefined && intent !== 'switch') throw new Error('intent must be "switch" when given');
  const result = await deps.execute('offerConnector', {
    roomId: deps.roomId,
    connectorType,
    reason,
    ...(intent ? { intent } : {}),
  });
  const offerId = typeof result.offerId === 'string' ? result.offerId : 'unknown';
  const joined = result.joined === true;
  if (intent === 'switch')
    return (
      `${joined ? 'already offered, card still open' : 'pending, card posted'}: switch ${connectorType} account [offer ${offerId}]. ` +
      'Tapping it opens a fresh Google sign-in that replaces the account it uses now; your turn is paused on this card. ' +
      'In prose, say that you are waiting for them to sign in with the account they want, then end your turn now; you will be woken once the new sign-in is connected.'
    );
  return (
    `${joined ? 'already offered, card still open' : 'pending, card posted'}: add ${connectorType} [offer ${offerId}]. ` +
    'The person you addressed, or a Workspace admin, can accept it with the one action on the card; ' +
    'your turn is paused on this offer. In prose, say what you learned about the tool and that you are waiting for them to add it, then end your turn now; ' +
    'you will be woken when it is added. Do not ask them to open Settings or the Connectors page — the card is the whole ask.'
  );
}




export function choiceOptionArgs(args: JsonObject): Array<{
  label: string;
  consequence: string;
  costly?: boolean;
}> {
  if (!Array.isArray(args.options)) throw new Error('options must be an array');
  return args.options.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('choice option is invalid');
    const entry = raw as Record<string, unknown>;
    if (typeof entry.label !== 'string' || !entry.label.trim()) {
      throw new Error('choice option label is required');
    }
    if (typeof entry.consequence !== 'string' || !entry.consequence.trim()) {
      throw new Error('choice option consequence is required');
    }
    return {
      label: entry.label,
      consequence: entry.consequence,
      ...(entry.costly === true ? { costly: true } : {}),
    };
  });
}




/** ask_choice: optional lettered question; the turn is not paused. */
export async function askChoice(
  args: JsonObject,
  deps: AgentGrantDeps = agentGrantDepsFromEnv(),
): Promise<string> {
  const result = await deps.execute('askRoomChoice', {
    roomId: deps.roomId,
    ...(typeof args.ask === 'string' ? { ask: args.ask } : {}),
    prompt: args.prompt,
    ...(typeof args.constraint === 'string' ? { constraint: args.constraint } : {}),
    options: choiceOptionArgs(args),
    ...(typeof args.ttl === 'number' ? { ttlSeconds: args.ttl } : {}),
  });
  const choiceId = typeof result.choiceId === 'string' ? result.choiceId : 'unknown';
  return (
    `posted [${choiceId}] · not paused · Skip or an option will wake you if you end this turn waiting. ` +
    'You may continue without the answer. A pick is a preference, never sandbox, spend, merge, or branch authority.'
  );
}
