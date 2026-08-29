/**
 * Phase-1 Beeline agent tool protocol.
 *
 * This file is the model-facing contract only. Identity, Workspace, Room,
 * repository, target-ref, and current-turn facts are intentionally absent
 * from tool arguments: the host derives them from the authenticated physical
 * session binding before invoking an action.
 */

export const BEELINE_AGENT_TOOL_SERVER_NAME = 'beeline-agent-tools';
export const BEELINE_AGENT_TOOL_SCHEMA_VERSION = 1 as const;
export const BEELINE_AGENT_TOOL_NAMES = [
  'read_mandate',
  'open_corner',
  'close_corner',
  'deliver',
] as const;

export type BeelineAgentToolName = (typeof BEELINE_AGENT_TOOL_NAMES)[number];
export type CloseCornerDisposition = 'land' | 'abandon';
export type DeliverAudience = 'current_corner' | 'parent_room';

export type BeelineActionToken = 'corner.open' | 'corner.close' | 'artifact.deliver';

export type BeelineActionScope =
  | {
      type: 'corner.open';
      workspaceId: string;
      roomId: string;
      repositoryKey: string;
      targetRef: string;
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

export interface OpenCornerResult {
  corner_id: string;
  feature_ref: string;
}

export interface CloseCornerResult {
  corner_id: string;
  disposition: CloseCornerDisposition;
  state: 'closed';
  landed_tip?: string;
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

export const BEELINE_AGENT_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    name: 'read_mandate',
    description:
      'Read the current signed authority generation, effective grants, explicit defaults, and blockers for this authenticated Beeline session.',
    inputSchema: { type: 'object', properties: {}, ...NO_EXTRA_PROPERTIES },
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

