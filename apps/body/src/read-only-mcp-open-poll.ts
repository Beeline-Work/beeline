import { agentToolsFor, toolValidationSchema, CAPABILITY_ROUTES, CAPABILITY_TOOLS, SCRATCH_ROUTES, placeBeelineApps } from "./minimal-tool-surface.js";
import { INSTITUTIONAL_SEARCH_QUERY_MAX_CHARACTERS, REPOSITORY_SUBSCRIPTION_EVENTS } from "@beeline/api-contract/daemon";
import { Check, Errors } from "typebox/value";
import { basename } from "node:path";
import { builtinBeelineApp } from "@beeline/api-contract/workbench";
import { SUBSCRIBABLE_EVENT_KINDS } from "@beeline/api-contract/phone";
import { JsonObject, grantRunDepsFromEnv, ToolDefinition, asObject, commandRequest, callCommandTool, readTurnContextFile, daemonExecute, requiredEnv } from './read-only-mcp.js';
import { AgentGrantDeps, agentGrantDepsFromEnv, choiceOptionArgs } from './read-only-mcp-agent-grant-deps.js';
import { namedPrivateFiles, attachRootsFromEnv, agentScheduleRoomId, agentScheduleDepsFromEnv, subscribeEvents, createSchedule, updateSchedule, deleteSchedule } from './read-only-mcp-download-attachment.js';
import { executeAgentOperation } from './read-only-mcp-execute-agent-operation.js';









/** open_poll: Room/corner only; a plurality is a fact, never a mandate. */
export async function openPoll(
  args: JsonObject,
  deps: AgentGrantDeps = agentGrantDepsFromEnv(),
): Promise<string> {
  const result = await deps.execute('openRoomPoll', {
    roomId: deps.roomId,
    prompt: args.prompt,
    ...(typeof args.constraint === 'string' ? { constraint: args.constraint } : {}),
    options: choiceOptionArgs(args),
    ttlSeconds: args.ttl,
  });
  const choiceId = typeof result.choiceId === 'string' ? result.choiceId : 'unknown';
  const electorate =
    typeof result.electorateCount === 'number' ? result.electorateCount : undefined;
  const closesAt =
    typeof result.closesAt === 'number'
      ? new Date(result.closesAt * 1000).toISOString()
      : undefined;
  return (
    `posted [${choiceId}] · electorate ${electorate ?? 'n'} · closes at ${closesAt ?? 'deadline'}. ` +
    'Not paused. A plurality is a preference fact: it does not grant sandbox reach, spend, merge, or branch-target authority. ' +
    'A tie or no votes means do not pick.'
  );
}




export interface GrantRunDeps {
  roomId: string;
  run: (input: { roomId: string; argv: string[] }) => Promise<JsonObject>;
}




/** run_granted_command: the daemon checks the rule and runs outside the sandbox. */
export async function runGrantedCommand(
  args: JsonObject,
  deps: GrantRunDeps = grantRunDepsFromEnv(),
): Promise<string> {
  const argv = args.argv;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((word) => typeof word === 'string' && word)
  ) {
    throw new Error('argv must be a non-empty array of words');
  }
  const result = await deps.run({ roomId: deps.roomId, argv: argv as string[] });
  const grantId = typeof result.grantId === 'string' ? result.grantId : 'unknown';
  const verdict =
    result.sandboxFailure === true
      ? 'sandbox failed before command start'
      : result.timedOut === true
        ? 'timed out after 10 minutes'
        : typeof result.exitCode === 'number'
          ? `exit ${result.exitCode}`
          : `did not start${typeof result.signal === 'string' ? ` (${result.signal})` : ''}`;
  const output = typeof result.output === 'string' && result.output ? result.output : '(no output)';
  const refused =
    result.writeRefused === true
      ? '\nThis Room is read-only outside your scratch directory. Open a corner with open_corner to change files; for host work there, ask with request_grant(kind:command, target, reason, purpose), then use run_granted_command.'
      : '';
  const recovery = result.sandboxFailure === true
    ? '\nFor host work, open a corner and ask with request_grant(kind:command, target, reason, purpose), then use run_granted_command.'
    : '';
  return `ran under grant ${grantId}: ${verdict}\n${output}${refused}${recovery}`;
}




export function advertisedAgentTool(name: string): ToolDefinition {
  const tool = agentToolsFor(true, process.env.BEELINE_AGENT_DM === '1', Boolean(process.env.BEELINE_DAEMON_CORNER_ID), process.env.BEELINE_CORNER_REPOSITORY === '1', Boolean(process.env.BEELINE_GRANT_RUNNER_URL), true, process.env.BEELINE_NATIVE_IO_PROVEN === '1').find(tool => tool.name === name);
  if (!tool) throw new Error(`unknown or unavailable tool: ${name}; use only advertised tools`);
  return tool;
}



export function validateAdvertisedToolInput(tool: ToolDefinition, args: JsonObject): void {
  // Restore root combinations while retaining surface-specific restrictions
  // such as scratch_io without quota. App operations have their own contracts
  // and may share a name (e.g. workflow read) with an ordinary tool.
  validateToolInput({ ...tool, inputSchema: { ...toolValidationSchema(tool.name), ...tool.inputSchema } }, args);
}



export function validateToolInput(tool: ToolDefinition, args: JsonObject): void {
  const requestedAction = args.action;
  if (tool.name === 'search' && typeof args.query === 'string'
    && [...args.query].length > INSTITUTIONAL_SEARCH_QUERY_MAX_CHARACTERS) {
    throw new Error(`search: query: at most ${INSTITUTIONAL_SEARCH_QUERY_MAX_CHARACTERS} characters`);
  }
  if (!Check(tool.inputSchema, args)) {
    if (tool.name === 'search') {
      const properties = asObject(tool.inputSchema.properties);
      const required = new Set(tool.inputSchema.required as string[] | undefined);
      const details = Object.entries(properties).flatMap(([field, rawSchema]) => {
        if (args[field] === undefined) return required.has(field) ? [`${field}: required`] : [];
        const rule = asObject(rawSchema);
        if (Check(rule, args[field])) return [];
        if (Array.isArray(rule.enum)) return [`${field}: expected one of ${(rule.enum as string[]).join(', ')}`];
        if (field === 'query') return [`${field}: expected a non-whitespace string of 1–500 characters without NUL`];
        if (field === 'limit') return [`${field}: expected an integer from ${rule.minimum} to ${rule.maximum}`];
        return [`${field}: invalid value`];
      });
      const extra = Object.keys(args).filter(field => !Object.hasOwn(properties, field));
      if (extra.length) details.push(`unknown fields: ${extra.join(', ')}; allowed fields: ${Object.keys(properties).join(', ')}`);
      throw new Error(`search: invalid arguments; ${details.join('; ')}; follow the advertised schema`);
    }
    if (tool.name === 'request_grant') {
      const properties = asObject(tool.inputSchema.properties);
      const branches = tool.inputSchema.anyOf as JsonObject[];
      const branch = branches.find(schema => Check(asObject(asObject(schema.properties).action), requestedAction ?? 'request'));
      const required = new Set([
        ...(tool.inputSchema.required as string[]),
        ...((branch?.required as string[] | undefined) ?? []),
      ]);
      // Build diagnostics from the advertised schema only, never request values.
      const details = Object.entries(properties).flatMap(([field, schema]) => {
        if (args[field] === undefined && !required.has(field)) return [];
        const rule = asObject(schema);
        if (Check(rule, args[field])) return [];
        const expectation = [
          rule.enum ? `one of ${(rule.enum as string[]).join(', ')}` : rule.type,
          rule.minLength !== undefined ? `at least ${rule.minLength} characters` : undefined,
          rule.maxLength !== undefined ? `at most ${rule.maxLength} characters` : undefined,
          rule.minimum !== undefined ? `at least ${rule.minimum}` : undefined,
        ].filter(Boolean).join(', ');
        return [`${field}: expected ${expectation}`];
      });
      if (Object.keys(args).some(field => !Object.hasOwn(properties, field)))
        details.push('input: expected only advertised fields');
      throw new Error(`${tool.name}: invalid arguments; ${details.join('; ')}; follow the advertised schema`);
    }
    const required = tool.inputSchema.required as string[] | undefined;
    const missing = required?.filter(field => args[field] === undefined);
    const extra = Object.keys(args).filter(field => !(field in asObject(tool.inputSchema.properties)));
    const branches = tool.name === 'revise_corner'
      ? (tool.inputSchema.allOf as JsonObject[]).filter(schema => Check(asObject(schema.if), args)).map(schema => schema.then)
      : tool.inputSchema.anyOf;
    const diagnosticSchema = tool.name === 'wake' || tool.name === 'revise_corner'
      ? { ...tool.inputSchema, allOf: undefined, anyOf: (branches as JsonObject[]).filter(schema => {
        const action = asObject(schema.properties).action;
        return !action || Check(action, requestedAction);
      }) }
      : tool.inputSchema;
    const details = tool.name === 'wake' || tool.name === 'revise_corner' || tool.name === 'search'
      ? Errors(diagnosticSchema, args).filter(error => error.keyword !== 'anyOf')
        .map(error => `${error.instancePath || 'input'}: ${error.message}`).join('; ')
      : '';
    throw new Error(`${tool.name}: invalid arguments${details ? `; ${details}` : ''}${missing?.length ? `; required: ${missing.join(', ')}` : ''}${extra.length ? `; unknown fields: ${extra.join(', ')}` : ''}; follow the advertised schema`);
  }
}



export const turnArtifacts = new Map<string, { uploads: { name: string; result: Promise<string> }[] }>();




export async function callAgentTool(name: string, args: JsonObject, toolCallId: string): Promise<string> {
  const {requestId,...input}=args;
  if(requestId!==undefined && (typeof requestId!=='string'||!requestId.length)) throw new Error('invalid claimed requestId');
  return commandRequest.run(requestId as string|undefined,
    () => callCommandTool(name, input, toolCallId));
}




/** Execute only the advertised vocabulary; internal operations retain server authority. */
export async function executeAgentTool(name: string, args: JsonObject, toolCallId: string, attachmentNames: string[] = []): Promise<string> {
  if (process.env.BEELINE_TURN_CONTEXT_FILE && (await readTurnContextFile()).terminalReason)
    throw new Error('turn has ended; further tool calls are refused');
  if (name === 'read' && args.cursor !== undefined &&
      (!args.cursor || typeof args.cursor !== 'object' || Array.isArray(args.cursor)))
    throw new Error('read: pass the returned next object unchanged as cursor');
  validateAdvertisedToolInput(advertisedAgentTool(name), args);
  let deliveryWarning = '';
  if (name === 'order' || name === 'report' || name === 'post') {
    const named = namedPrivateFiles(attachRootsFromEnv(), String(args.text ?? ''), true)
      .filter(file => basename(file.named) !== file.named || !attachmentNames.includes(file.named));
    if (named.length) deliveryWarning =
      `Warning: the ${name} names ${named.map(file => file.named).join(', ')}, which recipients may not be able to open; ` +
      'upload the file with post_artifact and name its attachment instead, or attach it to the target corner brief with revise_corner.';
  }
  const addressed = { ...args, ...(typeof args.address === 'string' ? { cornerId: args.address } : {}) };
  const execute = async (operation: string, input = args) => {
    const result = await executeAgentOperation(operation, input, toolCallId);
    return deliveryWarning ? `${result}\n\n${deliveryWarning}` : result;
  };
  switch (name) {
    case 'read': {
      const facet = args.facet;
      const requiredField = facet === 'message' ? 'messageId' : facet === 'attachment' ? 'attachmentId' : facet === 'procedure' ? 'slug' : undefined;
      if (requiredField && !args[requiredField]) throw new Error(`read: ${requiredField} is required for facet ${facet}`);
      const address = args.address ?? (process.env.BEELINE_DAEMON_CORNER_ID?.trim() || process.env.BEELINE_DAEMON_ROOM_ID);
      const input = { ...args, ...asObject(args.cursor), address, cornerId: address };
      switch (facet) {
        case 'addresses': return execute('list_rooms', input);
        case 'corners': return execute('list_corners', input);
        case 'members': return execute('list_room_members', input);
        case 'messages':
          // Every message read uses the same bounded cursor contract.
          return execute('inspect_corner', { ...input, from: args.from ?? (asObject(args.cursor).before ? 'newest' : undefined), mode: 'transcript' });
        case 'message': return execute('get_room_message', { ...input, messageId: args.messageId });
        case 'attachment': return execute('download_attachment', input);
        case 'brief': return execute('read_corner_brief', input);
        case 'status': return execute('inspect_corner', { ...input, mode: 'status' });
        case 'checks': return execute('pr_checks_status', input);
        case 'pr': return execute('read_pull_request', input);
        case 'procedure': return execute('load_workspace_skill', { ...input, slug: args.slug });
        case 'usage': return execute('read_agent_usage', {});
        default: throw new Error('unknown read facet');
      }
    }
    case 'search': {
      if (args.scope !== 'history' && args.scope !== 'memory') throw new Error('scope must be history or memory');
      return execute(args.scope === 'history' ? 'search_history' : 'search_memory');
    }
    case 'remember': {
      const routes: Record<string, Record<string, string>> = {
        fact: { save: 'save_memory', update: 'update_memory', delete: 'delete_memory', used: 'report_memory_used' },
        procedure: { save: 'save_skill', delete: 'delete_skill' },
      };
      const operation = routes[String(args.kind)]?.[String(args.action)];
      if (!operation) throw new Error('unknown remember kind/action');
      return execute(operation);
    }
    case 'revise_corner': {
      if (args.action === 'metadata') return execute('rename_corner', addressed);
      if (args.action !== 'brief' && args.action !== 'install_brief') throw new Error('action must be metadata, install_brief or brief');
      const copied = asObject(args.brief);
      // Projection metadata is read-only. Keep revision and change from the call,
      // and let the server resolve the approval and attachment metadata again.
      const input = { ...addressed, spec: copied.spec, repositoryWork: copied.repositoryWork,
        approval: copied.approval === undefined ? undefined : {
          sourceMessageId: asObject(copied.approval).sourceMessageId,
        },
        attachments: Array.isArray(copied.attachments) ? copied.attachments.map(item => {
          const file = asObject(item);
          return { ...(file.objectId !== undefined ? { objectId: file.objectId } : {}),
            ...(file.path !== undefined ? { path: file.path } : {}),
            purpose: file.purpose, required: file.required };
        }) : undefined,
      };
      if (args.action === 'install_brief') {
        const { spec, repositoryWork, approval, attachments } = input;
        return execute('rename_corner', { ...addressed, brief: { spec, repositoryWork, approval, attachments } });
      }
      return execute('revise_corner_brief', input);
    }
    case 'report':
    case 'report_feedback':
    case 'notify_feedback_fixed':
    case 'send_operator_system_dm':
    case 'read_operator_system_dm': return execute(name);
    case 'dispatch_release': return execute(name);
    case 'approve_merge':
    case 'merge_corner':
    case 'set_corner_hold':
    case 'post':
    case 'close_corner': return execute(name, addressed);
    case 'record_merge_yes': return execute('order_corner_merge', addressed);
    case 'close_corner_pr': return execute('close_pull_request', addressed);
    case 'request_grant':
      if (args.action === 'list') return execute('list_grants');
      if (args.action !== undefined && args.action !== 'request') throw new Error('action must be request or list');
      return execute(name);
    case 'connect': {
      const builtin = builtinBeelineApp(String(args.service ?? args.query ?? ''),
        `${args.reason ?? ''} ${args.continuation ?? ''}`);
      const capabilities = builtin || args.mode === 'discover' || args.mode === 'status'
        ? await availableCapabilities(!builtin || builtin === 'beeline:onboarding') : [];
      if (builtin === 'beeline:onboarding' && !capabilities.includes(builtin))
        return JSON.stringify({ status: 'unavailable', app: builtin, next: 'Repository cards are unavailable on this surface. Use an active Room with current members and retry the repository card.' });
      if (builtin && capabilities.includes(builtin) && (args.mode === undefined || ['status', 'ensure', 'discover'].includes(String(args.mode))))
        return JSON.stringify({ status: 'ready', app: builtin,
          next: `Use app_tool(app:${builtin}) to discover its tools. Existing tool permissions still apply.` });
      if (builtin && !capabilities.includes(builtin))
        return JSON.stringify({ status: 'unavailable', app: builtin, next: placeRefusal(builtin) });
      if (args.mode === 'status') return JSON.stringify({ readiness: await execute('connectors_status'), capabilities });
      if (args.mode === 'discover') return JSON.stringify({ integrations: args.query ? JSON.parse(await execute('find_connectors')) : [], capabilities });
      if (args.mode !== undefined && args.mode !== 'ensure') throw new Error('mode must be discover, status or ensure');
      return execute(name);
    }
    case 'app_tool': {
      const app = String(args.app ?? '');
      if (app.startsWith('beeline:')) {
        const capability = app.slice('beeline:'.length);
        if (!(await availableCapabilities(app === 'beeline:onboarding')).includes(app)) throw new Error(placeRefusal(app));
        const routes = CAPABILITY_ROUTES[capability]!;
        if (args.tool === undefined) return JSON.stringify({ app, tools: Object.entries(routes).map(([action]) => {
          const definition = CAPABILITY_TOOLS[capability]![action]!;
          return { ...definition, name: action, description: definition.description };
        }) });
        const operation = routes[String(args.tool)];
        if (!operation) throw new Error('unknown capability operation; discover its schema first');
        const input = { ...asObject(args.args ?? args.arguments) };
        const definition = CAPABILITY_TOOLS[capability]![String(args.tool)]!;
        validateToolInput(definition, input);
        if (capability === 'workflow' && args.tool === 'rebind') { input.agentId = input.agent; delete input.agent; }
        return execute(operation, input);
      }
      return args.tool === undefined
        ? execute('list_app_tools', { appId: app, query: args.query })
        : execute('execute_app_tool', { appId: app, tool: args.tool, arguments: args.args ?? args.arguments });
    }
    case 'scratch_io': {
      if (process.env.BEELINE_NATIVE_IO_PROVEN === '1') throw new Error('native IO is available');
      const operation = SCRATCH_ROUTES[String(args.action)];
      if (!operation) throw new Error('unknown scratch_io action');
      return execute(operation);
    }
    case 'wake': {
      if (args.action === 'delete' && args.trigger === undefined && args.scheduleId !== undefined)
        args = { ...args, trigger: 'schedule' };
      // Explicit allowlist: no payload can select an arbitrary daemon operation or recipient.
      const allowed = new Set(['action', 'trigger', 'address', 'scheduleId', 'subscriptionId', 'prompt', 'cadence', 'title', 'when', 'workflowName', 'source', 'event', 'repository', 'channelId', 'channelName', 'kinds']);
      if (Object.keys(args).some(key => !allowed.has(key))) throw new Error('wake only manages this agent’s own wake sources');
      if (args.trigger !== 'lifecycle' && args.address !== undefined) throw new Error('address is only supported for lifecycle wakes; schedules and events belong to this place');
      if (args.trigger === 'lifecycle' && !args.address) throw new Error('lifecycle wake requires address');
      const roomId = agentScheduleRoomId();
      const deps = { ...agentScheduleDepsFromEnv(), selfOnly: true };
      if (args.action === 'pause' || args.action === 'resume') {
        if (args.trigger === 'lifecycle') throw new Error('pause and resume apply to schedules and subscriptions');
        return JSON.stringify(await daemonExecute('setAgentWakePaused', { roomId,
          scheduleId: args.scheduleId as string | undefined, subscriptionId: args.subscriptionId as string | undefined,
          paused: args.action === 'pause' }));
      }
      if (args.action === 'list') {
        const [schedules, subscriptions, watches, events] = await Promise.all([
          daemonExecute('listAgentSchedules', { roomId, selfOnly: true }),
          daemonExecute('listAgentSubscriptions', { roomId }),
          daemonExecute('listAgentWatches', { roomId }),
          daemonExecute('listEventSubscriptions', { roomId }),
        ]);
        return JSON.stringify({ ...schedules, subscriptions, ...watches, events });
      }
      if (args.action === 'events') return JSON.stringify({ room: SUBSCRIBABLE_EVENT_KINDS,
        repository: REPOSITORY_SUBSCRIPTION_EVENTS,
        service: await daemonExecute('listServiceSubscriptionEvents', { roomId }) });
      if (args.action === 'replace_events') return subscribeEvents(args, deps);
      if (args.trigger === 'schedule') {
        if (args.action === 'create') return createSchedule(args, deps);
        if (args.action === 'update') return updateSchedule(args, deps);
        if (args.action === 'delete') return deleteSchedule(args, deps);
      }
      if (args.trigger === 'event') {
        if (args.action === 'create') return execute('create_subscription');
        if (args.action === 'delete') return execute('delete_subscription');
      }
      if (args.trigger === 'lifecycle') {
        if (args.action === 'create') return execute('watch');
        if (args.action === 'delete') return JSON.stringify(await daemonExecute('watchCorner', { roomId, cornerId: args.address, kinds: [] }));
      }
      throw new Error('unknown wake action/trigger');
    }
    case 'order':
    case 'stop':
    case 'open_corner':
    case 'post_artifact':
    case 'react_to_message':
    case 'run_granted_command':
    case 'no_reply_needed': return execute(name);
    default: throw new Error(`unknown tool: ${name}; use only tools/list names`);
  }
}




export async function availableCapabilities(checkOnboarding = true): Promise<string[]> {
  let onboarding = false;
  try {
    if (checkOnboarding) {
      const state = await daemonExecute('getRoomRepositoryState', { roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID') });
      onboarding = state.repositoryOnboarding === true;
    }
  } catch { /* Missing server eligibility always leaves the feature dark. */ }

  return placeBeelineApps(Boolean(process.env.BEELINE_DAEMON_CORNER_ID), onboarding);
}




/** The refusal for a Beeline app that does not work here names the apps that do. */
export function placeRefusal(app: string): string {
  const here = placeBeelineApps(Boolean(process.env.BEELINE_DAEMON_CORNER_ID)).join(', ');
  return `${app} ${app.slice('beeline:'.length) in CAPABILITY_ROUTES ? 'is unavailable in this place' : 'is not a Beeline app'}. Beeline apps here: ${here}.`;
}
