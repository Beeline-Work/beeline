/**
 * Beeline agent tool protocol.
 *
 * This file is the model-facing contract only. Identity, Workspace, Room,
 * repository, target-ref, and current-turn facts are intentionally absent
 * from tool arguments: the host derives them from the authenticated physical
 * session binding before invoking an action.
 */

export const BEELINE_AGENT_TOOL_SERVER_NAME = 'beeline-agent-tools';
export const BEELINE_AGENT_TOOL_SCHEMA_VERSION = 3 as const;
export const BEELINE_AGENT_TOOL_NAMES = [
  'read_mandate',
  'read_corner',
  'list_corners',
  'request_mandate',
  'open_corner',
  'close_corner',
  'schedule',
  'deliver',
] as const;

export type BeelineAgentToolName = (typeof BEELINE_AGENT_TOOL_NAMES)[number];
export type CloseCornerDisposition = 'land' | 'abandon';
export type DeliverAudience = 'current_corner' | 'parent_room';
export const BEELINE_SCHEDULE_OPERATIONS = [
  'create',
  'list',
  'get',
  'update',
  'pause',
  'resume',
  'cancel',
  'run_now',
] as const;
export type BeelineScheduleOperation = (typeof BEELINE_SCHEDULE_OPERATIONS)[number];

export const BEELINE_ACTION_TOKENS = [
  'corner.open',
  'corner.close',
  'schedule.create',
  'schedule.list',
  'schedule.get',
  'schedule.update',
  'schedule.pause',
  'schedule.resume',
  'schedule.cancel',
  'schedule.run_now',
  'artifact.deliver',
] as const;
export type BeelineActionToken = (typeof BEELINE_ACTION_TOKENS)[number];

export const BEELINE_MANDATE_DEFAULTS_VERSION = 2 as const;

/** New action tokens fail closed until this exact enumeration is deliberately changed. */
export const BEELINE_MANDATE_DEFAULTS: readonly EffectiveMandateDefault[] = [
  {
    action: 'corner.open',
    version: BEELINE_MANDATE_DEFAULTS_VERSION,
    effect: 'approval_required',
  },
  {
    action: 'corner.close',
    version: BEELINE_MANDATE_DEFAULTS_VERSION,
    effect: 'approval_required',
  },
  { action: 'schedule.create', version: BEELINE_MANDATE_DEFAULTS_VERSION, effect: 'allow' },
  { action: 'schedule.list', version: BEELINE_MANDATE_DEFAULTS_VERSION, effect: 'allow' },
  { action: 'schedule.get', version: BEELINE_MANDATE_DEFAULTS_VERSION, effect: 'allow' },
  { action: 'schedule.update', version: BEELINE_MANDATE_DEFAULTS_VERSION, effect: 'allow' },
  { action: 'schedule.pause', version: BEELINE_MANDATE_DEFAULTS_VERSION, effect: 'allow' },
  { action: 'schedule.resume', version: BEELINE_MANDATE_DEFAULTS_VERSION, effect: 'allow' },
  { action: 'schedule.cancel', version: BEELINE_MANDATE_DEFAULTS_VERSION, effect: 'allow' },
  { action: 'schedule.run_now', version: BEELINE_MANDATE_DEFAULTS_VERSION, effect: 'allow' },
  {
    action: 'artifact.deliver',
    version: BEELINE_MANDATE_DEFAULTS_VERSION,
    effect: 'allow',
  },
];

export type BeelineActionScope =
  | {
      type: 'corner.open';
      workspaceId: string;
      roomId: string;
      repositoryKey?: string;
      targetRef?: string;
    }
  | {
      type: 'corner.close';
      workspaceId: string;
      roomId: string;
      cornerId: string;
      disposition: CloseCornerDisposition;
      repositoryKey?: string;
      targetRef?: string;
      sourceSha?: string;
    }
  | {
      type: 'artifact.deliver';
      workspaceId: string;
      roomId: string;
      cornerId?: string;
      audience: DeliverAudience;
    }
  | {
      type: `schedule.${BeelineScheduleOperation}`;
      workspaceId: string;
      roomId: string;
      scheduleId?: string;
      repositoryKey?: string;
      targetRef?: string;
    };

export interface MandateGeneration {
  /** Signed event that owns this generation. */
  event_id: string;
  /** Monotonic/versioned generation carried by that signed event. */
  generation: number;
}

export interface EffectiveMandateGrant {
  action: BeelineActionToken;
  scope: BeelineActionScope;
  source: 'default' | 'signed-grant' | 'mission';
  event_id: string;
}

export interface EffectiveMandateDefault {
  action: BeelineActionToken;
  version: number;
  effect: 'allow' | 'approval_required' | 'deny';
}

export interface MandateBlocker {
  code: string;
  message: string;
}

export interface ReadMandateResult {
  schema_version: typeof BEELINE_AGENT_TOOL_SCHEMA_VERSION;
  generation: MandateGeneration;
  grants: EffectiveMandateGrant[];
  defaults: EffectiveMandateDefault[];
  blockers: MandateBlocker[];
}

export type DirectToolResult<T> =
  | { status: 'executed'; event_id: string; result: T }
  | {
      status: 'approval_pending';
      request_id: string;
      event_id: string;
      message: string;
    }
  | { status: 'denied'; code: string; message: string }
  | { status: 'failed'; code: string; retryable: boolean; message: string };

export type RequestMandateResult =
  | {
      status: 'granted';
      event_id: string;
      generation: MandateGeneration;
      beneficiary: string;
      action: BeelineActionToken;
      scope: BeelineActionScope;
    }
  | Exclude<DirectToolResult<never>, { status: 'executed' }>;

export type ScheduleCadenceInput =
  | { type: 'cron'; expression: string; timezone: string }
  | { type: 'daily'; local_time: string; timezone: string }
  | { type: 'interval'; every_seconds: number; anchor_at?: number };

export interface ScheduleConfigurationInput {
  operation: { type: 'agent_turn'; prompt: string };
  cadence: ScheduleCadenceInput;
  starts_at?: number;
  expires_at: number;
  max_runs: number;
  per_run_reserved_tokens: number;
  daily_reserved_tokens: number;
  catch_up: 'skip' | 'latest_one';
  max_consecutive_failures: number;
}

export interface OpenCornerResult {
  corner_id: string;
  feature_ref?: string;
}

export type CornerReadState = 'opening' | 'open' | 'working' | 'waiting' | 'idle' | 'concluded';

export interface CornerReadResult {
  request_id: string;
  exists: boolean;
  state: 'not_found' | CornerReadState;
  corner?: {
    corner_id: string;
    name: string;
    objective: string;
    feature_ref?: string;
    state: CornerReadState;
  };
}

export interface ListCornersResult {
  corners: readonly NonNullable<CornerReadResult['corner']>[];
}

export interface CloseCornerResult {
  corner_id: string;
  disposition: CloseCornerDisposition;
  state: 'closed';
  landed_tip?: string;
}

export interface PendingToolCloseBinding {
  turnId: string;
  sourceSha: string;
  targetRef: string;
  requestId: string;
  eventId: string;
}

export function cornerFrozenForPendingClose(input: {
  pending?: PendingToolCloseBinding;
  approved?: boolean;
}): boolean {
  return Boolean(input.pending && !input.approved);
}

export interface DeliverResult {
  artifact_id: string;
  url: string;
  name: string;
  sha256: string;
  size: number;
  mime_type: string;
}

export interface AgentToolDefinition {
  name: BeelineAgentToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

const NO_EXTRA_PROPERTIES = { additionalProperties: false } as const;
const MANDATE_SCOPE_SCHEMAS = [
  {
    type: 'object',
    required: ['type'],
    properties: {
      type: { const: 'corner.open' },
      repository_key: { type: 'string', minLength: 1, maxLength: 512 },
      target_ref: { type: 'string', minLength: 1, maxLength: 512 },
    },
    ...NO_EXTRA_PROPERTIES,
  },
  {
    type: 'object',
    required: ['type', 'corner_id', 'disposition'],
    properties: {
      type: { const: 'corner.close' },
      corner_id: { type: 'string', minLength: 1, maxLength: 256 },
      disposition: { type: 'string', enum: ['land', 'abandon'] },
      repository_key: { type: 'string', minLength: 1, maxLength: 512 },
      target_ref: { type: 'string', minLength: 1, maxLength: 512 },
      source_sha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
    },
    ...NO_EXTRA_PROPERTIES,
  },
  {
    type: 'object',
    required: ['type', 'audience'],
    properties: {
      type: { const: 'artifact.deliver' },
      audience: { type: 'string', enum: ['current_corner', 'parent_room'] },
      corner_id: { type: 'string', minLength: 1, maxLength: 256 },
    },
    ...NO_EXTRA_PROPERTIES,
  },
  ...BEELINE_SCHEDULE_OPERATIONS.map((operation) => ({
    type: 'object',
    required: ['type'],
    properties: {
      type: { const: `schedule.${operation}` },
      schedule_id: { type: 'string', minLength: 1, maxLength: 256 },
      repository_key: { type: 'string', minLength: 1, maxLength: 512 },
      target_ref: { type: 'string', minLength: 1, maxLength: 512 },
    },
    ...NO_EXTRA_PROPERTIES,
  })),
] as const;

export const BEELINE_AGENT_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    name: 'read_mandate',
    description:
      'Read the current signed authority generation, effective grants, explicit defaults, and blockers for this authenticated Beeline session.',
    inputSchema: { type: 'object', properties: {}, ...NO_EXTRA_PROPERTIES },
  },
  {
    name: 'read_corner',
    description:
      "Read host truth for the corner associated with this turn's triggering request. Use after any ambiguous open_corner outcome before claiming whether a corner exists.",
    inputSchema: { type: 'object', properties: {}, ...NO_EXTRA_PROPERTIES },
  },
  {
    name: 'list_corners',
    description:
      "List this authenticated Room's live corners with their current host state, objective, and feature ref.",
    inputSchema: { type: 'object', properties: {}, ...NO_EXTRA_PROPERTIES },
  },
  {
    name: 'request_mandate',
    description:
      'Request one typed standing-mandate action for this authenticated caller or an explicitly sponsored beneficiary. Covered authority returns granted; uncovered authority creates one signed pending request.',
    inputSchema: {
      type: 'object',
      required: ['action', 'scope'],
      properties: {
        action: { type: 'string', enum: [...BEELINE_ACTION_TOKENS] },
        scope: { oneOf: MANDATE_SCOPE_SCHEMAS },
        beneficiary: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      },
      ...NO_EXTRA_PROPERTIES,
    },
  },
  {
    name: 'open_corner',
    description:
      'Open one isolated Beeline corner for the objective. The host derives identity, Workspace, Room, repository, target ref, and retry identity from this session.',
    inputSchema: {
      type: 'object',
      required: ['objective'],
      properties: {
        objective: { type: 'string', minLength: 1, maxLength: 2_000 },
        repository: { type: 'string', minLength: 1, maxLength: 512 },
      },
      ...NO_EXTRA_PROPERTIES,
    },
  },
  {
    name: 'close_corner',
    description:
      'Close the current Beeline corner. land publishes the exact review-bound tip for approval or lands and archives when already mandated; abandon archives without landing.',
    inputSchema: {
      type: 'object',
      required: ['corner_id', 'disposition'],
      properties: {
        corner_id: { type: 'string', minLength: 1, maxLength: 256 },
        disposition: { type: 'string', enum: ['land', 'abandon'] },
      },
      ...NO_EXTRA_PROPERTIES,
    },
  },
  {
    name: 'schedule',
    description:
      'Create, inspect, update, pause, resume, cancel, or immediately run durable work on this Room calendar. The host validates canonical typed payloads and re-authorizes the scheduled action at every execution.',
    inputSchema: {
      type: 'object',
      required: ['operation'],
      properties: {
        operation: { type: 'string', enum: [...BEELINE_SCHEDULE_OPERATIONS] },
        schedule_id: { type: 'string', minLength: 1, maxLength: 256 },
        schedule: {
          type: 'object',
          required: [
            'operation',
            'cadence',
            'expires_at',
            'max_runs',
            'per_run_reserved_tokens',
            'daily_reserved_tokens',
            'catch_up',
            'max_consecutive_failures',
          ],
          properties: {
            operation: {
              type: 'object',
              required: ['type', 'prompt'],
              properties: {
                type: { const: 'agent_turn' },
                prompt: { type: 'string', minLength: 1, maxLength: 32_000 },
              },
              ...NO_EXTRA_PROPERTIES,
            },
            cadence: {
              oneOf: [
                {
                  type: 'object',
                  required: ['type', 'expression', 'timezone'],
                  properties: {
                    type: { const: 'cron' },
                    expression: { type: 'string', minLength: 1, maxLength: 256 },
                    timezone: { type: 'string', minLength: 1, maxLength: 128 },
                  },
                  ...NO_EXTRA_PROPERTIES,
                },
                {
                  type: 'object',
                  required: ['type', 'local_time', 'timezone'],
                  properties: {
                    type: { const: 'daily' },
                    local_time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
                    timezone: { type: 'string', minLength: 1, maxLength: 128 },
                  },
                  ...NO_EXTRA_PROPERTIES,
                },
                {
                  type: 'object',
                  required: ['type', 'every_seconds'],
                  properties: {
                    type: { const: 'interval' },
                    every_seconds: { type: 'integer', minimum: 60 },
                    anchor_at: { type: 'integer' },
                  },
                  ...NO_EXTRA_PROPERTIES,
                },
              ],
            },
            starts_at: { type: 'integer' },
            expires_at: { type: 'integer' },
            max_runs: { type: 'integer', minimum: 1, maximum: 1_000_000 },
            per_run_reserved_tokens: { type: 'integer', minimum: 0 },
            daily_reserved_tokens: { type: 'integer', minimum: 0 },
            catch_up: { type: 'string', enum: ['skip', 'latest_one'] },
            max_consecutive_failures: { type: 'integer', minimum: 1, maximum: 1_000_000 },
          },
          ...NO_EXTRA_PROPERTIES,
        },
      },
      ...NO_EXTRA_PROPERTIES,
    },
  },
  {
    name: 'deliver',
    description:
      'Snapshot and deliver one artifact to the current corner or its parent Room. Use path for an existing regular file, or name+content for a small inline artifact.',
    inputSchema: {
      type: 'object',
      oneOf: [
        {
          required: ['path'],
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 4_096 },
            name: { type: 'string', minLength: 1, maxLength: 255 },
            audience: { type: 'string', enum: ['current_corner', 'parent_room'] },
            note: { type: 'string', maxLength: 600 },
          },
          ...NO_EXTRA_PROPERTIES,
        },
        {
          required: ['name', 'content'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            content: { type: 'string', maxLength: 1_000_000 },
            audience: { type: 'string', enum: ['current_corner', 'parent_room'] },
            note: { type: 'string', maxLength: 600 },
          },
          ...NO_EXTRA_PROPERTIES,
        },
      ],
    },
  },
];

export function isBeelineAgentToolName(value: unknown): value is BeelineAgentToolName {
  return (BEELINE_AGENT_TOOL_NAMES as readonly unknown[]).includes(value);
}

export function assertBeelineAgentToolHandshake(input: {
  serverInfo?: { name?: string; version?: string };
  toolNames: readonly string[];
}): void {
  if (
    input.serverInfo?.name !== BEELINE_AGENT_TOOL_SERVER_NAME ||
    input.serverInfo.version !== String(BEELINE_AGENT_TOOL_SCHEMA_VERSION)
  ) {
    throw new Error('Beeline agent-tool server identity/schema handshake failed');
  }
  const expected = new Set<string>(BEELINE_AGENT_TOOL_NAMES);
  const actual = new Set(input.toolNames);
  if (expected.size !== actual.size || [...expected].some((name) => !actual.has(name))) {
    throw new Error('Beeline agent-tool inventory handshake failed');
  }
}
