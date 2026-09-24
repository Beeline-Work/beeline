#!/usr/bin/env node
/**
 * Deliberately narrow MCP server for repository inspection and private-memory
 * persistence in Room sessions.
 *
 * Security properties:
 *   - exposes exactly one mutation: replacing this agent's daemon-pinned
 *     Workspace MEMORY.md through a bounded, non-symlink file descriptor;
 *   - exposes no shell, generic process, or raw git-argument tool;
 *   - resolves every requested path through the configured repository root;
 *   - never follows a symlink outside that root and never exposes `.git`;
 *   - invokes only three fixed, local git read commands with optional locks,
 *     pagers, hooks, fsmonitor, external diff, and text conversion disabled.
 *
 * Repository writes remain the responsibility of buzz-dev-mcp in an isolated
 * edit-corner worktree after the signed human ALLOW flow.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CORNER_NAME_MAX_LENGTH,
  CORNER_NAME_MAX_WORDS,
  CORNER_OBJECTIVE_MAX_LENGTH,
  CORNER_OBJECTIVE_MAX_WORDS,
  cornerTextRefusal,
  normalizeCornerText,
  ARTIFACT_MIME_BY_EXTENSION,
  ARTIFACT_MIME_TYPES,
  type ArtifactMimeType,
  type CornerRestoreResult,
  type RoomConversationResult,
} from '@beeline/api-contract/daemon';
import {
  AGENT_GRANT_KINDS,
  AGENT_GRANT_REASON_MAX_LENGTH,
  AGENT_GRANT_TARGET_MAX_LENGTH,
  AGENT_GRANT_VERBS,
  GRANT_SCRIPT_MAX_BYTES,
  GRANT_SCRIPT_MAX_LINES,
  formatGrantEscalationReason,
  grantScriptTooLongMessage,
  interpreterScriptArgument,
  isAgentGrantKind,
  parseCommandGrantTarget,
  type AgentGrantEscalation,
  type CommandGrantRule,
  type CommandGrantScript,
} from '@beeline/api-contract/agent-grants';
import {
  CONNECTOR_OFFER_REASON_MAX_LENGTH,
  OFFERABLE_CONNECTOR_KINDS,
  isOfferableConnectorKind,
} from '@beeline/api-contract/connector-offers';
import {
  MAX_EVENT_CONSEQUENCE_LENGTH,
  MAX_MENTIONS_PER_EVENT,
  SERVER_EVENT_KINDS,
  CHOICE_CONSTRAINT_MAX_LENGTH,
  CHOICE_CONSEQUENCE_MAX_LENGTH,
  CHOICE_LABEL_MAX_LENGTH,
  CHOICE_OPTIONS_MAX,
  CHOICE_OPTIONS_MIN,
  CHOICE_PROMPT_MAX_LENGTH,
  CHOICE_TTL_SECONDS,
  isAgentKind,
  isServerEventKind,
  MESSAGE_REACTION_EMOJIS,
  type CornerLifecycleView,
  type MessageReactionEmoji,
} from '@beeline/api-contract/phone';
import { READ_ONLY_TOOL_NAMES } from './read-only-policy.js';
import {
  YOUTUBE_MCP_SERVER_NAME,
  YOUTUBE_MCP_SURFACE,
  YOUTUBE_MCP_TOOLS,
  callYoutubeTool,
  youtubeClientFromToken,
} from './youtube-mcp.js';
import { validateArtifact } from './artifact-validation.js';
import {
  BoundedSizeError,
  FETCH_TIMEOUT_MS,
  MAX_ATTACHMENT_BYTES,
  fetchBoundedBytes,
} from './attachment-delivery.js';
import { computePatchId } from './patch-identity.js';

type JsonObject = Record<string, unknown>;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_MEMORY_BYTES = 2 * 1024 * 1024;
const MAX_GIT_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.expo',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

const READ_ONLY_TOOLS: ToolDefinition[] = [
  {
    name: 'list_files',
    description:
      'List files under the repository without changing them. Symlinks are listed but never followed during traversal.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative directory; defaults to .' },
        max_depth: { type: 'integer', minimum: 1, maximum: 8, default: 3 },
        limit: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      'Read a bounded line range from one text file inside the repository. Paths outside the repository and .git are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative file path.' },
        start_line: { type: 'integer', minimum: 1, default: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_agent_file',
    description:
      "Read one text file from this agent's approved materialized skills or Workspace memory. It cannot access harness config, credentials, repositories, other agents, or execute content.",
    inputSchema: {
      type: 'object',
      required: ['area', 'path'],
      properties: {
        area: { type: 'string', enum: ['skills', 'memory'] },
        path: { type: 'string', description: 'Path relative to the selected approved area.' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'write_memory',
    description:
      "Replace this agent's private Workspace MEMORY.md. This is the only supported memory-write path in a read-only Room; shell writes to memory are always denied.",
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: {
          type: 'string',
          description: 'The complete new UTF-8 contents of MEMORY.md.',
          maxLength: MAX_MEMORY_BYTES,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_text',
    description:
      'Search for a literal text string in bounded repository text files. This is a safe grep-like search, not a shell or regex evaluator.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        path: {
          type: 'string',
          description: 'Repository-relative file or directory; defaults to .',
        },
        case_sensitive: { type: 'boolean', default: false },
        max_results: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_log',
    description:
      'Read bounded local commit history, optionally scoped to one repository path. It cannot contact remotes or change git state.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        path: { type: 'string', description: 'Optional repository-relative path.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'git_show',
    description:
      'Read one local commit and its patch with external diff and text conversion disabled. Revision syntax is intentionally restricted.',
    inputSchema: {
      type: 'object',
      properties: {
        revision: {
          type: 'string',
          description: 'HEAD, HEAD~N, a commit hash, or refs/heads|tags/...; defaults to HEAD.',
        },
        path: { type: 'string', description: 'Optional repository-relative path filter.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'git_diff',
    description:
      'Read a local commit-to-commit diff. Working-tree and staged diffs are intentionally unavailable because repository filters can execute commands.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Restricted local revision; defaults to HEAD~1.' },
        to: { type: 'string', description: 'Restricted local revision; defaults to HEAD.' },
        path: { type: 'string', description: 'Optional repository-relative path filter.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'git_status',
    description:
      'Read the working-tree state. Does not invoke textconv or external diff, so the security concerns that exclude git_diff for working-tree content do not apply.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional repository-relative path filter.' },
      },
      additionalProperties: false,
    },
  },
];

const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'wallet_address',
    description:
      "Show your connected owner's wallet: the EVM address (and the Solana address when there is one) and whether a wallet is linked at all. Call this before wallet_pay when you need an address to receive funds.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'wallet_balance',
    description:
      "Read your connected owner's wallet balances: the total USD value and every holding. This is the wallet you spend from; there is no other limit on spending than what the balance holds.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'wallet_chains',
    description:
      "List the chains your owner's wallet can pay and swap on, with the network fee on each and whether the fee is sponsored (free to send).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'wallet_history',
    description:
      "Read your owner's wallet ledger, oldest first: every transaction in and out, who spent (agents are named), the counterparty, chain and the balance that remained.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: 'wallet_quote',
    description:
      'Quote one send before making it: the network fee (or that it is sponsored), whether the balance covers the amount, and what is available. Always quote when the amount is large or the balance looks tight.',
    inputSchema: {
      type: 'object',
      required: ['asset', 'amount'],
      properties: {
        chain: { type: 'string', description: 'Defaults to base.' },
        asset: { type: 'string', description: 'Asset symbol, e.g. usdc or eth.' },
        amount: { type: 'string', description: 'Amount to send, in the asset.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wallet_pay',
    description:
      "Send crypto from your connected owner's wallet to one address. Requires the owner's live delegated-signing grant; an expired grant is returned as delegation-expired and means your owner must re-grant permission in the app. The only other refusal is insufficient funds. Every send is written to the @wallet ledger.",
    inputSchema: {
      type: 'object',
      required: ['asset', 'amount', 'to'],
      properties: {
        chain: { type: 'string', description: 'Defaults to base.' },
        asset: { type: 'string', description: 'Asset symbol to send, e.g. usdc.' },
        amount: { type: 'string', description: 'Amount to send, in the asset.' },
        to: { type: 'string', description: 'The recipient address on that chain.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wallet_swap',
    description:
      "Swap one asset for another inside your owner's wallet (e.g. usdc to eth). Same grant and ledger rules as wallet_pay.",
    inputSchema: {
      type: 'object',
      required: ['fromAsset', 'toAsset', 'amount'],
      properties: {
        chain: { type: 'string', description: 'Defaults to base.' },
        fromAsset: { type: 'string' },
        toAsset: { type: 'string' },
        amount: { type: 'string', description: 'Amount to swap, in fromAsset.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'steer_corner',
    description:
      'Pass a change in this Room down to work in a corner you belong to. The hand-off queues input for the corner opener.',
    inputSchema: {
      type: 'object',
      required: ['cornerId', 'text'],
      properties: {
        cornerId: { type: 'string' },
        text: { type: 'string', minLength: 1, maxLength: 16000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_corner',
    description:
      'Read compact corner status by default. Set mode to transcript for bounded oldest-first pages; pass the returned next.after and next.offset to continue, including long messages.',
    inputSchema: {
      type: 'object',
      required: ['cornerId'],
      properties: {
        cornerId: { type: 'string' },
        mode: { type: 'string', enum: ['status', 'transcript'] },
        after: { type: 'string', description: 'The after cursor from transcript next.' },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'The body offset from transcript next.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ask_corner',
    description:
      'Ask the corner opener one question. The returned id is the askId for get_corner_ask. The answer wakes your next Room turn and is linked to the corner card.',
    inputSchema: {
      type: 'object',
      required: ['cornerId', 'text'],
      properties: {
        cornerId: { type: 'string' },
        text: { type: 'string', minLength: 1, maxLength: 16000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_corner_ask',
    description:
      'Retrieve your corner question by the askId returned by ask_corner, including its answer or unanswered close status.',
    inputSchema: {
      type: 'object',
      required: ['askId'],
      properties: { askId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'react_to_message',
    description:
      'React to one message in this Room. The reaction stays present if this call is retried. Use only one of the supported emoji.',
    inputSchema: {
      type: 'object',
      required: ['messageId', 'emoji'],
      properties: {
        messageId: { type: 'string', description: 'The message id from the Room transcript.' },
        emoji: { type: 'string', enum: [...MESSAGE_REACTION_EMOJIS] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_schedule',
    description:
      'Create a schedule that runs your prompt as a mention to you in this Room, on an interval (everyMinutes, minimum 1) or a 5-field cron. With maxRuns the schedule deletes itself after that many runs.',
    inputSchema: {
      type: 'object',
      required: ['prompt', 'cadence'],
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description: 'The prompt delivered to you as a Room mention on every run.',
        },
        cadence: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['interval', 'cron'] },
            everyMinutes: {
              type: 'integer',
              minimum: 1,
              description: 'Interval cadence: run every N minutes (minimum 1).',
            },
            expression: {
              type: 'string',
              description: 'Cron cadence: a 5-field cron expression.',
            },
            timeZone: { type: 'string', description: 'Optional IANA time zone for cron.' },
          },
          additionalProperties: false,
        },
        maxRuns: {
          type: 'integer',
          minimum: 1,
          description: 'Delete the schedule automatically after this many runs.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_schedules',
    description: 'List the schedules you own in this Room, with their cadence and run counts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'delete_schedule',
    description:
      'Delete one of your own schedules in this Room. You can only delete schedules you created.',
    inputSchema: {
      type: 'object',
      required: ['scheduleId'],
      properties: {
        scheduleId: {
          type: 'string',
          description: 'The scheduleId from create_schedule or list_schedules.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'subscribe_events',
    description:
      `Choose which things happening in this Room wake you for a turn: ${SERVER_EVENT_KINDS.join(', ')}. ` +
      'Subscribe to joined and every newcomer wakes you, so you can greet them - a person arriving ' +
      'in the Workspace wakes you too when that arrival projects into this Room. This REPLACES your ' +
      'current list, so send every kind you want, not just the new one; call list_event_subscriptions ' +
      'first if you are not sure what you already react to, and send an empty list to react to nothing.',
    inputSchema: {
      type: 'object',
      required: ['kinds'],
      properties: {
        kinds: {
          type: 'array',
          items: { type: 'string', enum: [...SERVER_EVENT_KINDS] },
          description: 'The complete list of event kinds you want to react to in this Room.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_event_subscriptions',
    description: 'List the events you currently react to in this Room.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'emit_event',
    description:
      'State one thing that happened, as a line in this Room, and optionally wake other agents with it. ' +
      'The kind is your own agent:<slug> label (lower-case letters, digits and hyphens) and the sentence ' +
      'is what happened; both appear in the transcript for people to read. Name at most ' +
      `${MAX_MENTIONS_PER_EVENT} agent members of this Room in mentionAgentIds to wake them. Events chain, ` +
      'and the chain is bounded: past a few hops, or once one chain has woken too many turns, the emit is ' +
      'refused and nothing is posted - answer in the Room instead.',
    inputSchema: {
      type: 'object',
      required: ['kind', 'consequence'],
      properties: {
        kind: {
          type: 'string',
          description: 'Your label for this event, as agent:<slug>, e.g. "agent:handoff".',
        },
        consequence: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_EVENT_CONSEQUENCE_LENGTH,
          description: 'One sentence saying what happened.',
        },
        mentionAgentIds: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_MENTIONS_PER_EVENT,
          description: 'Agent members of this Room to wake with this event.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'open_corner',
    description:
      'Open one write-enabled corner. Call this only after a person confirmed the proposed objective, or when their message itself commanded the corner with its scope. In a repository Room it gets an isolated git worktree; in a chat-only Room it gets a writable scratch workspace for non-repository work and artifact delivery. Pass lane="no_code" in a repository Room when the objective produces no code change. Give it a name of AT MOST THREE WORDS and a fixed objective of no more than 24 words.',
    inputSchema: {
      type: 'object',
      required: ['name', 'objective'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: CORNER_NAME_MAX_LENGTH,
          description: `The corner's title: at most ${CORNER_NAME_MAX_WORDS} words, no line breaks.`,
        },
        objective: {
          type: 'string',
          minLength: 1,
          maxLength: CORNER_OBJECTIVE_MAX_LENGTH,
          description: `One paragraph of at most ${CORNER_OBJECTIVE_MAX_WORDS} words stating the complete, fixed objective.`,
        },
        lane: {
          type: 'string',
          enum: ['code', 'no_code'],
          description:
            'Defaults to "code". Use "no_code" for an objective that produces no code change: the corner skips the worktree, the commit, the pull request and the merge, and delivers artifacts plus a reply tagging you.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'post_artifact',
    description:
      'Post one artifact into this Room or corner: it is uploaded now and delivered as an attachment under your next reply. This is the only way to share a file - there is no separate attach tool. Two ways to supply content: pass path for a file that already exists in your checkout or writable session home (title and mime then default to the file name and its extension), or pass html (markup text) or bytes (base64) directly, never both content forms. HTML and SVG must be fully self-contained - all CSS in an inline <style>, images only as data: URLs; every script, <link>, <iframe>, <object>, <embed>, <form>, inline event handler and http(s) reference is refused, because the viewer runs with script off. A PDF must start with the %PDF- signature. The other formats are size-checked only. Capped at 25 MB. Use it when a design decision needs eyes: build the page, post it, then ask for feedback here in the Room.',
    inputSchema: {
      type: 'object',
      required: [],
      properties: {
        path: {
          type: 'string',
          description:
            'Path of an existing file inside your checkout or writable session home, e.g. one written by write_scratch_file.',
          maxLength: 1024,
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'The artifact title, e.g. "Room list mock". Titles the card everywhere. Optional when posting by path (defaults to the file name); required for html/bytes content.',
        },
        mime: {
          type: 'string',
          enum: [...ARTIFACT_MIME_TYPES],
          description:
            'The artifact mime type; it selects the validator and the viewer. Optional when posting by path (defaults to the file extension).',
        },
        html: {
          type: 'string',
          description:
            'The document as text. Use for text/html and image/svg+xml (and small text/markdown).',
        },
        bytes: {
          type: 'string',
          description: 'The artifact content base64-encoded. Use for binary formats.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'publish_corner_app',
    description:
      'Create or replace one native Corner App shared with every member of this corner. The app is declarative: headings, text, fields, notices, and prompt actions only. Its command becomes a dynamic /slash-command without a client release.',
    inputSchema: {
      type: 'object',
      required: ['slug', 'title', 'command', 'blocks'],
      properties: {
        slug: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
        title: { type: 'string', minLength: 1, maxLength: 80 },
        description: { type: 'string', minLength: 1, maxLength: 240 },
        command: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
        blocks: {
          type: 'array',
          maxItems: 40,
          items: {
            oneOf: [
              {
                type: 'object',
                required: ['type', 'text'],
                properties: {
                  type: { const: 'heading' },
                  text: { type: 'string', minLength: 1, maxLength: 120 },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['type', 'text'],
                properties: {
                  type: { const: 'text' },
                  text: { type: 'string', minLength: 1, maxLength: 4000 },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['type', 'items'],
                properties: {
                  type: { const: 'fields' },
                  items: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 24,
                    items: {
                      type: 'object',
                      required: ['label', 'value'],
                      properties: {
                        label: { type: 'string', minLength: 1, maxLength: 80 },
                        value: { type: 'string', minLength: 1, maxLength: 500 },
                      },
                      additionalProperties: false,
                    },
                  },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['type', 'text'],
                properties: {
                  type: { const: 'notice' },
                  text: { type: 'string', minLength: 1, maxLength: 1000 },
                  tone: { type: 'string', enum: ['neutral', 'warning'] },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['type', 'label', 'prompt'],
                properties: {
                  type: { const: 'action' },
                  label: { type: 'string', minLength: 1, maxLength: 80 },
                  prompt: { type: 'string', minLength: 1, maxLength: 2000 },
                },
                additionalProperties: false,
              },
            ],
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'open_corner_app',
    description:
      'Ask everyone reading this corner to open one persisted Corner App. This posts an app row they can enter; it never executes app content.',
    inputSchema: {
      type: 'object',
      required: ['slug'],
      properties: { slug: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' } },
      additionalProperties: false,
    },
  },
  {
    name: 'close_corner',
    description:
      'Close this corner after its task is complete. Only the agent that opened the corner may close it, because closing is terminal for every member: it archives the corner and stops everyone working in it. Attach every file you want to keep before closing - the local workspace is deleted as soon as this turn finishes. In a repository corner that workspace is the git worktree, and its feature branch is deleted locally and on GitHub only when it has no open pull request or that pull request already merged; an open pull request keeps its branch, because deleting it would close the pull request and make the commits recoverable only from GitHub. Close only work that has landed or is being abandoned. Already-attached files remain available from the Room.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pr_checks_status',
    description:
      'Read GitHub checks and the complete merge-authority gate for a pull request. Pass pullRequest (number or full GitHub URL) when reviewing a PR this corner did not author; use the PR named in your objective or conversation. Defaults to this corner’s own PR. The result reports the configured reviewer outcome, worker yolo mode, existing human hold, and whether a reviewer is configured; approvalPending stays true unless all four authorize the merge. reviewerWake says whether the configured reviewer was woken. Never infer passing checks from local git, gh output, or chat prose, and never invent a cause for a missing review.',
    inputSchema: {
      type: 'object',
      properties: {
        pullRequest: {
          anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }],
          description: 'PR number in this Room repository, or its full GitHub pull request URL.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'approve_merge',
    description:
      'Record the configured reviewer’s PASS for the exact pull-request head you reviewed. This does not merge. Only the parent Room’s configured reviewer_agent_id may call this — no other agent’s call clears the gate, and a corner’s own opener cannot call it unless it is also that reviewer. Call it only after a complete beeline-review PASS, using that review’s full head SHA; then tag the implementer with approval and clearance to merge.',
    inputSchema: {
      type: 'object',
      required: ['headSha'],
      properties: {
        headSha: {
          type: 'string',
          pattern: '^[0-9a-fA-F]{40}$',
          description: 'The exact 40-character Git head SHA that passed review.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'write_scratch_file',
    description:
      'Write a file into your writable session area (the same root post_artifact reads paths from, beyond your checkout) and return its path so post_artifact can post it. This is how you create a file at all in a Room, whose filesystem is otherwise read-only. Content is plain text by default; pass encoding "base64" to write bytes you computed yourself. Capped at the same size post_artifact allows. Path must be relative and stay inside your session area - no absolute paths, no .. traversal, no symlink escapes; in a corner this still writes only to your session area, never the worktree. This produces the file, not a picture: turning text, markdown, JSON or SVG into a raster image needs a converter, which needs shell, which a Room does not have.',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: {
          type: 'string',
          description: 'Relative path inside your writable session area, e.g. "notes/summary.md".',
          maxLength: 1024,
        },
        content: {
          type: 'string',
          description: 'The file content: plain text, or base64 when encoding is "base64".',
        },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64'],
          description: 'How to interpret content. Defaults to utf8.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'fetch_image',
    description:
      'Download one photograph from an http(s) URL into your writable session home and return its path, mime, and size. Use this when a mock needs a real product photo: read the bytes, base64-encode them, and put them in your HTML as a data: URL, then post_artifact. The artifact validator still refuses every http(s) image reference, and the phone viewer only paints data: images — an <img src="https://…"> never shows. Capped at 25 MB with a 30-second timeout. JPEG, PNG, GIF, and WebP only; SVG and HTML are refused. The artifact stays a snapshot — this fetch happens now, on the daemon, not when someone opens the page.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'http(s) URL of a JPEG, PNG, GIF, or WebP photograph.',
          maxLength: 2048,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'request_grant',
    description:
      "Raise your hand for reach outside the sandbox: kind path|host|secret|device|budget|command|mcp with one target and the reason. Under yolo a path, host, secret, device or command is approved at once, but budget and mcp never are — those always wait for a person. Otherwise a card goes to your owner and your turn pauses on it: tell the human what you are waiting for and end the turn, you are woken when they answer. A request for mcp squire is answered in your owner’s Trusty Squire DM; your current Room receives the answer wake. A command target is the exact line you want to run, no shell metacharacters; name secrets with a `--with SECRET_NAME` suffix. An mcp target is one MCP server the operator already runs on this host, spelled exactly as it is named in their harness config — an approved route is written into your isolated home and mounts on the approval wake's fresh session. Use it as soon as that wake resumes your work; do not restart or schedule another turn. Yolo is the scope gate: with it on, an approved command just runs. Exactly two shapes always wait for a person anyway, in a Room and in a corner alike: running a script nobody has read (the card carries the script in full and the approval is bound to those exact bytes — rewrite the file and the run is refused), and anything naming a credential or environment file.",
    inputSchema: {
      type: 'object',
      required: ['kind', 'target', 'reason'],
      properties: {
        kind: { type: 'string', enum: [...AGENT_GRANT_KINDS] },
        target: {
          type: 'string',
          minLength: 1,
          maxLength: AGENT_GRANT_TARGET_MAX_LENGTH,
          description:
            'What you need: a path, a host, a secret name, a device, a budget, the exact command line (with optional `--with SECRET_NAME` suffixes), or — for kind mcp — the exact name of a host MCP server as spelled in the operator harness config.',
        },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: AGENT_GRANT_REASON_MAX_LENGTH,
          description: 'One sentence: what you will do with it.',
        },
        ttl: {
          type: 'integer',
          minimum: 60,
          description: 'Optional lifetime in seconds after which the grant expires.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'workbench_status',
    description:
      'Read the Workbench as it stands for the person you are answering: the connector catalog (each tool, what it is for, whether it can be added today and whether you may offer it from here), which of those tools this person already has and on which machine, and the connections (provisioned keys) they hold — by service and label only, never a value. Call this BEFORE you tell anyone a tool is missing and before offer_connector: a tool they already have is used, not offered again. Free to call; it changes nothing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'offer_connector',
    description:
      'Offer to add ONE Workbench tool (connector) you need for the work in front of you, at the moment you need it. A card goes into this Room, spoken by you and addressed to the person you are answering; it carries your reason, a fixed line naming the consequence and the safety boundary, and ONE affirmative action. Only that person or a Workspace admin can accept; accepting pairs the tool on YOUR machine, and the sign-in or keys are theirs, never in chat. Your turn pauses on the card: say in prose what you found out about the tool and what you are waiting for, then end the turn — you are woken when someone accepts. Never offer a tool you have not looked into: if you do not already know what it is, research it first and say so in your reply BEFORE calling this. This is setup, not authority: it never replaces a grant, write permission, target-branch confirmation or the merge gate.',
    inputSchema: {
      type: 'object',
      required: ['connectorType', 'reason'],
      properties: {
        connectorType: {
          type: 'string',
          enum: [...OFFERABLE_CONNECTOR_KINDS],
          description: 'The catalog connectorType from workbench_status that is marked offerable.',
        },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: CONNECTOR_OFFER_REASON_MAX_LENGTH,
          description:
            'One short clause: what you will do once it is added, e.g. "provision the 1inch API key into its vault".',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ask_choice',
    description:
      'Post an optional lettered question (A–D) for a human in this Room. This is a preference, not a grant: it does not pause your turn and Skip or timeout means continue without that input. Never use this for sandbox reach, spend, merge, or branch-target authority.',
    inputSchema: {
      type: 'object',
      required: ['prompt', 'options'],
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: CHOICE_PROMPT_MAX_LENGTH,
          description: 'One sentence. The card title.',
        },
        constraint: {
          type: 'string',
          maxLength: CHOICE_CONSTRAINT_MAX_LENGTH,
          description: 'Optional one-line constraint under the title.',
        },
        options: {
          type: 'array',
          minItems: CHOICE_OPTIONS_MIN,
          maxItems: CHOICE_OPTIONS_MAX,
          items: {
            type: 'object',
            required: ['label', 'consequence'],
            properties: {
              label: { type: 'string', minLength: 1, maxLength: CHOICE_LABEL_MAX_LENGTH },
              consequence: {
                type: 'string',
                minLength: 1,
                maxLength: CHOICE_CONSEQUENCE_MAX_LENGTH,
              },
              costly: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        ttl: {
          type: 'integer',
          enum: [...CHOICE_TTL_SECONDS],
          description: 'Optional lifetime in seconds (5m / 15m / 1h / 4h / 24h).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'open_poll',
    description:
      'Open a time-bounded poll of every human in this Room. Refused in DMs, below two electors, and above fifty. A plurality is a fact, never permission to deploy, delete, merge, or spend. Required ttl from 5m / 15m / 1h / 4h / 24h.',
    inputSchema: {
      type: 'object',
      required: ['prompt', 'options', 'ttl'],
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: CHOICE_PROMPT_MAX_LENGTH,
        },
        constraint: {
          type: 'string',
          maxLength: CHOICE_CONSTRAINT_MAX_LENGTH,
        },
        options: {
          type: 'array',
          minItems: CHOICE_OPTIONS_MIN,
          maxItems: CHOICE_OPTIONS_MAX,
          items: {
            type: 'object',
            required: ['label', 'consequence'],
            properties: {
              label: { type: 'string', minLength: 1, maxLength: CHOICE_LABEL_MAX_LENGTH },
              consequence: {
                type: 'string',
                minLength: 1,
                maxLength: CHOICE_CONSEQUENCE_MAX_LENGTH,
              },
              costly: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        ttl: {
          type: 'integer',
          enum: [...CHOICE_TTL_SECONDS],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'run_granted_command',
    description:
      'Run a command under an approved command grant, only when an approved grant is a word-for-word prefix of argv. In a top-level Room it runs on the SAME read-only filesystem the Room promises — you can read anything and write only your own scratch, so open a corner for work that changes files. A corner can do everything a Room can and more: its worktree is writable and a command there may act on the live host, next to the branch and the transcript that explain it. The named secrets are in its environment and never in the output. Ten-minute timeout, capped output, one ledger row per run.',
    inputSchema: {
      type: 'object',
      required: ['argv'],
      properties: {
        argv: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1 },
          description: 'The command and its arguments as separate words.',
        },
      },
      additionalProperties: false,
    },
  },
];

const agentSurface = process.env.BEELINE_MCP_SURFACE === 'agent';
const youtubeSurface = process.env.BEELINE_MCP_SURFACE === YOUTUBE_MCP_SURFACE;

/** The bounded daemon-control tools for one surface. A direct message is
 *  strictly conversational: repository corners are never openable there. */
export function agentToolsFor(
  agentSurface: boolean,
  directMessage: boolean,
  cornerTurn = false,
  reviewer = false,
  commandRunnerAvailable = true,
  agentMayCloseCorner = cornerTurn,
): ToolDefinition[] {
  if (!agentSurface) return READ_ONLY_TOOLS;
  return AGENT_TOOLS.filter((tool) => {
    if (['steer_corner', 'ask_corner', 'get_corner_ask', 'inspect_corner'].includes(tool.name))
      return !directMessage && !cornerTurn;
    if (tool.name === 'approve_merge') return cornerTurn && reviewer;
    // A connector is offered where a person is answering — a Room or a DM —
    // never from a corner, whose work is the branch (R5).
    if (tool.name === 'workbench_status' || tool.name === 'offer_connector') return !cornerTurn;
    if (tool.name === 'open_corner') return !directMessage && !cornerTurn;
    if (tool.name === 'close_corner') return cornerTurn && agentMayCloseCorner;
    if (tool.name === 'publish_corner_app' || tool.name === 'open_corner_app') return cornerTurn;
    if (tool.name === 'open_poll') return !directMessage;
    if (tool.name === 'run_granted_command') return commandRunnerAvailable;
    return true;
  });
}

const TOOLS = youtubeSurface
  ? [...YOUTUBE_MCP_TOOLS]
  : agentToolsFor(
      agentSurface,
      process.env.BEELINE_AGENT_DM === '1',
      Boolean(process.env.BEELINE_DAEMON_CORNER_ID),
      process.env.BEELINE_CORNER_REVIEWER === '1',
      Boolean(process.env.BEELINE_GRANT_RUNNER_URL),
      process.env.BEELINE_CORNER_AGENT_CLOSE === '1',
    );

const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
// Nothing else ties TOOLS' names to READ_ONLY_TOOL_NAMES (the auto-allow
// permission check's canonical list) — assert they match so the two can't
// silently drift apart the way they did before this check existed.
{
  const declaredNames = new Set(READ_ONLY_TOOLS.map((tool) => tool.name));
  const policyNames = new Set<string>(READ_ONLY_TOOL_NAMES);
  const mismatched =
    declaredNames.size !== policyNames.size ||
    [...declaredNames].some((name) => !policyNames.has(name));
  if (mismatched) {
    throw new Error(
      `read-only-mcp TOOLS [${[...declaredNames].join(', ')}] has drifted from ` +
        `read-only-policy.ts READ_ONLY_TOOL_NAMES [${READ_ONLY_TOOL_NAMES.join(', ')}]`,
    );
  }
}

function configuredRoot(): string {
  const candidate = process.env.BEELINE_READONLY_ROOT?.trim() || process.cwd();
  return realpathSync(candidate);
}

/** Additional daemon-derived paths (e.g. corner worktrees) the read tools may
 *  access. Never model-supplied. Semicolon-separated absolute paths. */
const EXTRA_ROOTS: string[] = (process.env.BEELINE_READONLY_EXTRA_ROOTS?.trim() ?? '')
  .split(';')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return '';
    }
  })
  .filter(Boolean);

const repositoryRoot = configuredRoot();
const approvedAgentRoots = Object.fromEntries(
  [
    ['skills', process.env.BEELINE_READONLY_AGENT_SKILLS_ROOT],
    ['memory', process.env.BEELINE_READONLY_AGENT_MEMORY_ROOT],
  ].flatMap(([area, value]) => {
    if (!value?.trim()) return [];
    try {
      const candidate = resolve(value);
      const details = lstatSync(candidate);
      const real = realpathSync(candidate);
      if (!details.isDirectory() || details.isSymbolicLink() || real !== candidate) return [];
      return [[area, real]];
    } catch {
      return [];
    }
  }),
) as Partial<Record<'skills' | 'memory', string>>;
const gitBinary = ['/usr/bin/git', '/bin/git'].find((candidate) => existsSync(candidate));

function asObject(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tool arguments must be an object');
  }
  return value as JsonObject;
}

function stringArg(args: JsonObject, name: string, fallback?: string): string | undefined {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function booleanArg(args: JsonObject, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function integerArg(
  args: JsonObject,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function assertRelativePath(input: string): string {
  if (!input || input.includes('\0') || isAbsolute(input)) {
    throw new Error('path must be a non-empty repository-relative path');
  }
  const normalized = input.replaceAll('\\', '/');
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
  if (segments.includes('..') || segments.some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error('path escapes the repository inspection boundary');
  }
  return normalized;
}

function withinRepository(realPath: string): boolean {
  const rel = relative(repositoryRoot, realPath);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return true;
  // Also allow paths under any daemon-derived extra root (e.g. corner worktrees).
  return EXTRA_ROOTS.some((extra) => realPath.startsWith(extra + sep) || realPath === extra);
}

function existingPath(input: string, expected: 'file' | 'directory' | 'either'): string {
  const relativePath = assertRelativePath(input);
  const candidate = resolve(repositoryRoot, relativePath);
  const resolved = realpathSync(candidate);
  if (!withinRepository(resolved)) {
    throw new Error('path resolves outside the repository inspection boundary');
  }
  const details = statSync(resolved);
  if (expected === 'file' && !details.isFile()) throw new Error('path is not a regular file');
  if (expected === 'directory' && !details.isDirectory())
    throw new Error('path is not a directory');
  return resolved;
}

function displayPath(path: string): string {
  const shown = relative(repositoryRoot, path).replaceAll('\\', '/');
  return shown || '.';
}

function shouldSkipDirectory(name: string): boolean {
  return DEFAULT_IGNORED_DIRECTORIES.has(name);
}

function listFiles(args: JsonObject): string {
  const start = existingPath(stringArg(args, 'path', '.')!, 'directory');
  const maxDepth = integerArg(args, 'max_depth', 3, 1, 8);
  const limit = integerArg(args, 'limit', 500, 1, 2000);
  const output: string[] = [];

  const visit = (directory: string, depth: number) => {
    if (output.length >= limit || depth > maxDepth) return;
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (output.length >= limit) break;
      if (entry.name.toLowerCase() === '.git') continue;
      const path = resolve(directory, entry.name);
      const shown = displayPath(path);
      if (entry.isSymbolicLink()) {
        output.push(`${shown}@`);
        continue;
      }
      if (entry.isDirectory()) {
        output.push(`${shown}/`);
        if (!shouldSkipDirectory(entry.name)) visit(path, depth + 1);
        continue;
      }
      if (entry.isFile()) output.push(shown);
    }
  };

  visit(start, 1);
  return `${output.join('\n')}${output.length >= limit ? `\n[truncated at ${limit} entries]` : ''}`;
}

function readTextFile(path: string, maximumBytes = MAX_READ_BYTES): string {
  const details = statSync(path);
  if (details.size > maximumBytes) {
    throw new Error(`file exceeds the ${maximumBytes}-byte inspection limit`);
  }
  const bytes = readFileSync(path);
  if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) {
    throw new Error('binary files are not exposed by the read-only text tools');
  }
  return bytes.toString('utf8');
}

function readFile(args: JsonObject): string {
  const path = existingPath(stringArg(args, 'path') ?? '', 'file');
  const text = readTextFile(path);
  const lines = text.split(/\r?\n/);
  const startLine = integerArg(args, 'start_line', 1, 1, Math.max(1, lines.length));
  const requestedEnd = integerArg(
    args,
    'end_line',
    Math.min(lines.length, startLine + 999),
    startLine,
    Math.max(startLine, lines.length),
  );
  const endLine = Math.min(requestedEnd, startLine + 999);
  const body = lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join('\n');
  return `${displayPath(path)} (${lines.length} lines)\n${body}${requestedEnd > endLine ? '\n[truncated at 1000 lines]' : ''}`;
}

function readAgentFile(args: JsonObject): string {
  const area = stringArg(args, 'area');
  if (area !== 'skills' && area !== 'memory') throw new Error('area must be skills or memory');
  const root = approvedAgentRoots[area];
  if (!root) throw new Error(`approved ${area} material is unavailable`);
  const input = stringArg(args, 'path') ?? '';
  if (!input || input.includes('\0') || isAbsolute(input)) {
    throw new Error('path must be relative to the approved agent area');
  }
  const normalized = input.replaceAll('\\', '/');
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
  if (segments.includes('..')) throw new Error('path escapes the approved agent area');
  let component = root;
  for (const segment of segments) {
    component = resolve(component, segment);
    if (lstatSync(component).isSymbolicLink()) {
      throw new Error('approved agent reads do not follow symbolic links');
    }
  }
  const candidate = resolve(root, normalized);
  const resolved = realpathSync(candidate);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('path resolves outside the approved agent area');
  }
  const linkStats = lstatSync(candidate);
  const details = statSync(resolved);
  if (linkStats.isSymbolicLink() || !details.isFile() || details.nlink !== 1) {
    throw new Error('approved agent reads require an ordinary file');
  }
  const text = readTextFile(resolved);
  const lines = text.split(/\r?\n/);
  const startLine = integerArg(args, 'start_line', 1, 1, Math.max(1, lines.length));
  const requestedEnd = integerArg(
    args,
    'end_line',
    Math.min(lines.length, startLine + 999),
    startLine,
    Math.max(startLine, lines.length),
  );
  const endLine = Math.min(requestedEnd, startLine + 999);
  return `${area}/${normalized} (${lines.length} lines)\n${lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join('\n')}${requestedEnd > endLine ? '\n[truncated at 1000 lines]' : ''}`;
}

function writeMemory(args: JsonObject): string {
  if (Object.keys(args).some((key) => key !== 'content')) {
    throw new Error('write_memory accepts only content');
  }
  const content = stringArg(args, 'content');
  if (content === undefined) throw new Error('content must be a string');
  if (content.includes('\0')) throw new Error('memory content must be UTF-8 text');
  if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_BYTES) {
    throw new Error(`memory content exceeds the ${MAX_MEMORY_BYTES}-byte limit`);
  }
  const root = approvedAgentRoots.memory;
  if (!root) throw new Error('approved memory material is unavailable');
  const candidate = resolve(root, 'MEMORY.md');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(candidate, constants.O_WRONLY | constants.O_NOFOLLOW);
    const details = fstatSync(descriptor);
    if (!details.isFile() || details.nlink !== 1) {
      throw new Error('memory writes require an ordinary private MEMORY.md');
    }
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return `memory/MEMORY.md updated (${Buffer.byteLength(content, 'utf8')} bytes)`;
}

function searchableFiles(start: string): string[] {
  const details = statSync(start);
  if (details.isFile()) return [start];
  const files: string[] = [];
  const visit = (directory: string) => {
    const entries: Dirent[] = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.toLowerCase() === '.git' || entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  visit(start);
  return files.sort();
}

function searchText(args: JsonObject): string {
  const query = stringArg(args, 'query') ?? '';
  if (!query || query.length > 256) throw new Error('query must contain 1 to 256 characters');
  const start = existingPath(stringArg(args, 'path', '.')!, 'either');
  const caseSensitive = booleanArg(args, 'case_sensitive', false);
  const maxResults = integerArg(args, 'max_results', 50, 1, 200);
  const needle = caseSensitive ? query : query.toLocaleLowerCase('en-US');
  const matches: string[] = [];
  let inspectedBytes = 0;

  for (const path of searchableFiles(start)) {
    if (matches.length >= maxResults || inspectedBytes >= MAX_SEARCH_TOTAL_BYTES) break;
    const details = lstatSync(path);
    if (!details.isFile() || details.size > MAX_SEARCH_FILE_BYTES) continue;
    inspectedBytes += details.size;
    let text: string;
    try {
      text = readTextFile(path, MAX_SEARCH_FILE_BYTES);
    } catch {
      continue;
    }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const haystack = caseSensitive ? line : line.toLocaleLowerCase('en-US');
      if (!haystack.includes(needle)) continue;
      matches.push(`${displayPath(path)}:${index + 1}:${line.slice(0, 500)}`);
      if (matches.length >= maxResults) break;
    }
  }

  if (!matches.length) return 'No matches.';
  const truncated = matches.length >= maxResults || inspectedBytes >= MAX_SEARCH_TOTAL_BYTES;
  return `${matches.join('\n')}${truncated ? `\n[truncated at ${matches.length} matches]` : ''}`;
}

function revisionArg(args: JsonObject, name: string, fallback: string): string {
  const revision = stringArg(args, name, fallback)!;
  const valid =
    /^(?:HEAD(?:~[0-9]{1,4})?|[0-9a-fA-F]{4,64}|refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240})$/.test(
      revision,
    ) && !revision.includes('..');
  if (!valid) throw new Error(`${name} is not an allowed local revision`);
  return revision;
}

function optionalPath(args: JsonObject): string | undefined {
  const input = stringArg(args, 'path');
  if (input === undefined) return undefined;
  const path = existingPath(input, 'either');
  return displayPath(path);
}

function runGit(args: string[]): string {
  if (!gitBinary) throw new Error('trusted system git is unavailable');
  try {
    return execFileSync(
      gitBinary,
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.attributesFile=/dev/null',
        '--no-pager',
        '-C',
        repositoryRoot,
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: MAX_GIT_BYTES,
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_EXTERNAL_DIFF: '',
          GIT_NO_LAZY_FETCH: '1',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
          PAGER: 'cat',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trimEnd();
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '').trim()
        : '';
    throw new Error(stderr || 'git inspection command failed');
  }
}

function gitLog(args: JsonObject): string {
  const limit = integerArg(args, 'limit', 20, 1, 100);
  const path = optionalPath(args);
  return runGit([
    'log',
    '--no-show-signature',
    `--max-count=${limit}`,
    '--date=iso-strict',
    '--format=%H%x09%ad%x09%an%x09%s',
    ...(path ? ['--', path] : []),
  ]);
}

function gitShow(args: JsonObject): string {
  const revision = revisionArg(args, 'revision', 'HEAD');
  const path = optionalPath(args);
  return runGit([
    'show',
    '--no-ext-diff',
    '--no-textconv',
    '--no-show-signature',
    '--format=fuller',
    '--stat',
    '--patch',
    '--max-count=1',
    revision,
    ...(path ? ['--', path] : []),
  ]);
}

function gitDiff(args: JsonObject): string {
  const from = revisionArg(args, 'from', 'HEAD~1');
  const to = revisionArg(args, 'to', 'HEAD');
  const path = optionalPath(args);
  return runGit([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--stat',
    '--patch',
    from,
    to,
    ...(path ? ['--', path] : []),
  ]);
}

function gitStatus(args: JsonObject): string {
  const path = optionalPath(args);
  return runGit(['status', '--porcelain=v2', '--no-ahead-behind', ...(path ? ['--', path] : [])]);
}

function callTool(name: string, args: JsonObject): string {
  switch (name) {
    case 'list_files':
      return listFiles(args);
    case 'read_file':
      return readFile(args);
    case 'read_agent_file':
      return readAgentFile(args);
    case 'write_memory':
      return writeMemory(args);
    case 'search_text':
      return searchText(args);
    case 'git_log':
      return gitLog(args);
    case 'git_show':
      return gitShow(args);
    case 'git_diff':
      return gitDiff(args);
    case 'git_status':
      return gitStatus(args);
    default:
      throw new Error(`tool is not available in read-only mode: ${name}`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`agent tool is missing host context: ${name}`);
  return value;
}

async function activeCommandContext(): Promise<{
  roomId: string;
  requestId: string;
  generationId: string;
}> {
  const { readFile } = await import('node:fs/promises');
  const value = JSON.parse(await readFile(requiredEnv('BEELINE_TURN_CONTEXT_FILE'), 'utf8'));
  if (!value.roomId || !value.requestId || !value.generationId)
    throw new Error('no active server command');
  return value;
}

async function daemonExecute(name: string, input: JsonObject): Promise<JsonObject> {
  const baseUrl = requiredEnv('BEELINE_DAEMON_BASE_URL');
  const response = await fetch(new URL(`/v1/daemon/operations/${name}`, `${baseUrl}/`), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requiredEnv('BEELINE_DAEMON_TOKEN')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...input,
      ...(process.env.BEELINE_TURN_CONTEXT_FILE &&
      !name.startsWith('get') &&
      !name.startsWith('list')
        ? await activeCommandContext()
        : {}),
    }),
  });
  if (!response.ok) {
    let code = 'request_failed';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') code = body.error;
    } catch {
      // Never reflect a server body into the model-facing tool error.
    }
    throw new Error(`daemon operation ${name} failed (${response.status}: ${code})`);
  }
  return (await response.json()) as JsonObject;
}

/** The corner's two texts, flattened and judged. Anything that reads as a
 *  refusal is one plain sentence naming the limit and the actual count: a
 *  refused call the model cannot understand is a silent one (C90). */
export function cornerCallText(args: JsonObject): { name: string; objective: string } {
  const refusal =
    cornerTextRefusal('name', args.name) ?? cornerTextRefusal('objective', args.objective);
  if (refusal) throw new Error(refusal);
  return {
    name: normalizeCornerText(String(args.name)),
    objective: normalizeCornerText(String(args.objective)),
  };
}

async function relayMessage(direction: 'down', args: JsonObject, reply = false): Promise<string> {
  const cornerId = process.env.BEELINE_DAEMON_CORNER_ID?.trim();
  if (process.env.BEELINE_AGENT_DM === '1' || Boolean(cornerId))
    throw new Error('corner relay requires a Room turn');
  if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000)
    throw new Error('relay text must contain 1 to 16000 characters');
  const context = await activeCommandContext();
  const toRoomId = args.cornerId;
  if (typeof toRoomId !== 'string' || !toRoomId) throw new Error('cornerId is required');
  const sent = await daemonExecute('postRoomMessage', {
    text: args.text,
    relay: {
      fromRoomId: context.roomId,
      toRoomId,
      direction,
      ...(reply ? { reply: 'once' } : {}),
    },
  });
  return JSON.stringify(reply ? { ...sent, askId: sent.id } : sent);
}

async function openCorner(args: JsonObject, toolCallId: string): Promise<string> {
  if (process.env.BEELINE_DAEMON_CORNER_ID || process.env.BEELINE_AGENT_DM === '1') {
    throw new Error('open_corner is available only in a top-level Room');
  }
  const { name, objective } = cornerCallText(args);
  if (args.lane !== undefined && args.lane !== 'code' && args.lane !== 'no_code') {
    throw new Error('lane must be "code" or "no_code"');
  }
  const lane = args.lane === 'no_code' ? ('no_code' as const) : ('code' as const);
  const roomId = requiredEnv('BEELINE_DAEMON_ROOM_ID');
  const repository = await daemonExecute('getRoomRepositoryState', { roomId });
  if (repository.resolution === 'unverified') {
    throw new Error('open_corner is waiting for the Room repository state to resolve');
  }
  if (repository.resolution === 'repository' && (!repository.key || !repository.remote)) {
    throw new Error('open_corner requires a complete verified repository binding');
  }
  const requestId = (await activeCommandContext()).requestId;
  const idempotencyKey = createHash('sha256')
    .update(`open_corner\0${requestId}\0${toolCallId}`)
    .digest('hex');
  const created = await daemonExecute('createCorner', {
    roomId,
    requestId,
    idempotencyKey,
    name,
    objective,
    lane,
    ...(repository.resolution === 'repository'
      ? {
          repository: repository.key,
          ...(typeof repository.targetBranch === 'string'
            ? { targetBranch: repository.targetBranch }
            : {}),
        }
      : {}),
  });
  if (typeof created.cornerId !== 'string' || !created.cornerId) {
    throw new Error('createCorner returned no corner id');
  }
  return JSON.stringify({
    cornerId: created.cornerId,
    name,
    objective,
    // A chat-only Room has no code lane to take, so report what was recorded.
    lane: repository.resolution === 'repository' ? lane : 'no_code',
    status: 'starting',
  });
}

/**
 * Close the corner this tool is running in, chat-only or repository-backed.
 *
 * There is no surface-side repository check: archiving is one operation with
 * one owner, and the server already reserves it for the agent that opened the
 * corner (`CORNER_OPENER_ONLY_OPERATIONS`). A repository corner that is done
 * — merged by someone else, or abandoned — could otherwise only be closed by a
 * human, which left finished corners running.
 */
async function closeCorner(): Promise<string> {
  const cornerId = requiredEnv('BEELINE_DAEMON_CORNER_ID');
  if (process.env.BEELINE_CORNER_AGENT_CLOSE !== '1') {
    throw new Error('no-code corners stay open until a human closes them');
  }
  await daemonExecute('archiveCorner', { cornerId });
  return JSON.stringify({ cornerId, status: 'closed' });
}

/** Best-effort patch-id of this worktree's HEAD against the corner's target
 * branch. Never throws: an absent id just falls back to exact head-sha
 * matching on the server side. */
async function cornerPatchId(cornerId: string): Promise<string | undefined> {
  try {
    const result = await daemonExecute('getRoomTargetBranch', { roomId: cornerId });
    const targetBranch = result.targetBranch;
    if (typeof targetBranch !== 'string' || !targetBranch) return undefined;
    return await computePatchId({ worktreePath: configuredRoot(), targetBranch });
  } catch {
    return undefined;
  }
}

function cornerMergeAllowed(input: {
  reviewFailed: boolean;
  isWorkerYolo: boolean;
  didHumanSayDontMerge: boolean;
  reviewerExists: boolean;
}): boolean {
  if (input.reviewFailed) return false;
  if (!input.isWorkerYolo) return false;
  if (input.didHumanSayDontMerge) return false;
  if (!input.reviewerExists) return false;
  return true;
}

export async function prChecksStatus(args: JsonObject = {}): Promise<string> {
  const cornerId = requiredEnv('BEELINE_DAEMON_CORNER_ID');
  const workspaceId = requiredEnv('BEELINE_DAEMON_WORKSPACE_ID');
  const agentId = requiredEnv('BEELINE_DAEMON_AGENT_ID');
  const [restore, conversation, roster, authority, configuration] = await Promise.all([
    daemonExecute('getCornerRestoreState', { cornerId }),
    // Newest page: a hold, an approval and a PR link are questions about where
    // the corner stands NOW, and this scan is last-write-wins over the page.
    daemonExecute('getRoomConversation', { roomId: cornerId, limit: 200 }),
    daemonExecute('getWorkspaceRoster', { agentId, workspaceId }),
    daemonExecute('getRoomAuthority', { roomId: cornerId, principalId: agentId }),
    daemonExecute('getAgentConfiguration', { agentId, roomId: cornerId }),
  ]);
  const humans = new Set(
    Array.isArray(roster.members)
      ? roster.members.flatMap((member) => {
          if (!member || typeof member !== 'object' || Array.isArray(member)) return [];
          const record = member as Record<string, unknown>;
          return record.kind === 'human' && typeof record.identityId === 'string'
            ? [record.identityId]
            : [];
        })
      : [],
  );
  const lifecycle = restore.lifecycle as CornerLifecycleView | undefined;
  let held = false;
  let pullRequest: unknown = args.pullRequest ?? lifecycle?.pr?.url;
  // An objective URL is a target hint only, never a check verdict.
  if (pullRequest === undefined && typeof restore.objective === 'string')
    pullRequest = restore.objective.match(
      /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/,
    )?.[0];
  const items = Array.isArray(conversation.items) ? conversation.items : [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const message = item as Record<string, unknown>;
    const body = typeof message.body === 'string' ? message.body : '';
    const url = body.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/)?.[0];
    if (url && args.pullRequest === undefined && !lifecycle?.pr?.url) pullRequest = url;
    if (typeof message.authorId === 'string' && humans.has(message.authorId)) {
      if (/\bhold\b|\bdo not merge\b|\bdon't merge\b/i.test(body)) held = true;
      if (/\bresume\b|\bproceed\b|\bgo ahead\b|\bmerge now\b/i.test(body)) held = false;
    }
  }
  const verdict =
    pullRequest !== undefined
      ? await daemonExecute('getPrChecksStatus', { cornerId, pullRequest })
      : undefined;
  if (verdict) pullRequest = verdict.pullRequest;
  const checks =
    verdict?.checks === 'passed' || verdict?.checks === 'failed' || verdict?.checks === 'pending'
      ? verdict.checks
      : 'unknown';
  const headSha = typeof verdict?.headSha === 'string' ? verdict.headSha : lifecycle?.pr?.headSha;
  const pullRequestNumber =
    typeof pullRequest === 'number'
      ? pullRequest
      : typeof pullRequest === 'string'
        ? Number(pullRequest.match(/(?:pull\/)?(\d+)(?:\D*)$/)?.[1]) || lifecycle?.pr?.number
        : lifecycle?.pr?.number;
  const reason =
    checks === 'unknown'
      ? pullRequestNumber
        ? `no checks are recorded for PR #${pullRequestNumber} (head ${headSha ?? 'unknown'}); the PR may have been opened from a branch that is not this corner's, or checks have not reported yet`
        : 'no pull request or checks are recorded for this corner'
      : checks === 'passed'
        ? 'all recorded checks passed'
        : checks === 'failed'
          ? 'one or more recorded checks failed'
          : 'recorded checks are still pending';
  const reviewer = typeof verdict?.reviewer === 'string' ? verdict.reviewer : null;
  const reviewerExists = verdict?.reviewerExists === true;
  const reviewerIsAuthor = verdict?.reviewerIsAuthor === true;
  const reviewerRule = typeof verdict?.rule === 'string' ? verdict.rule : undefined;
  const reviewerWake =
    verdict?.reviewerWake && typeof verdict.reviewerWake === 'object'
      ? verdict.reviewerWake
      : undefined;
  const reviewFailed = verdict ? verdict.approvalPending !== false : true;
  const isWorkerYolo = configuration.yoloMode === true;
  const didHumanSayDontMerge = held;
  const mergeAllowed = cornerMergeAllowed({
    reviewFailed,
    isWorkerYolo,
    didHumanSayDontMerge,
    reviewerExists,
  });
  const mergeConditionsRule =
    "Merge only when checks is passed and mergeAllowed is true — then YOU merge it yourself with gh. mergeAllowed is true only when reviewFailed is false, isWorkerYolo is true, didHumanSayDontMerge is false, and reviewerExists is true; missing state is never consent. The server never merges a corner's pull request and never sends a closing request of any kind. If gh pr merge refuses because the branch is not up to date with its target, bring it up to date (gh pr update-branch, or merge the target branch in) and push, wait for checks to report on the new head, then merge again.";
  return JSON.stringify({
    checks,
    reason,
    ...(headSha ? { headSha } : {}),
    held,
    didHumanSayDontMerge,
    reviewFailed,
    isWorkerYolo,
    reviewerExists,
    mergeAllowed,
    approvalPending: !mergeAllowed,
    reviewer,
    reviewerIsAuthor,
    ...(reviewerWake ? { reviewerWake } : {}),
    archived: authority.archived === true,
    ...(pullRequest ? { pullRequest } : {}),
    ...(!pullRequest
      ? {
          next: 'The PR URL is not yet durable in the corner. Print its full URL as your final response and end this turn now; do not call pr_checks_status again in this turn.',
        }
      : {}),
    rule: [reviewerRule, mergeConditionsRule].filter(Boolean).join(' '),
  });
}

export async function approveMerge(args: JsonObject = {}): Promise<string> {
  const cornerId = requiredEnv('BEELINE_DAEMON_CORNER_ID');
  const headSha = typeof args.headSha === 'string' ? args.headSha.toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error('headSha must be a full 40-character SHA');
  const patchId = await cornerPatchId(cornerId);
  return JSON.stringify(await daemonExecute('approveCornerMerge', { cornerId, headSha, patchId }));
}

export interface WriteScratchFileDeps {
  /** The agent's own writable session area - the same scratch root
   *  post_artifact treats as a second legal root, never the checkout/worktree. */
  root: string;
}

export function writeScratchFileDepsFromEnv(): WriteScratchFileDeps {
  return { root: requiredEnv('BEELINE_ATTACH_SCRATCH_ROOT') };
}

/** Resolve a write_scratch_file target strictly inside `root`: relative
 *  input only, no absolute paths, no traversal, and no symlink escape
 *  through an existing ancestor directory. The file need not exist yet, so
 *  (unlike resolveAttachPath) this walks up to the deepest existing
 *  ancestor to real-path-check it, then creates any missing directories
 *  beneath that point - which, freshly created, cannot themselves be
 *  symlinks. */
export function resolveWriteScratchPath(root: string, input: string): string {
  if (!input || input.includes('\0'))
    throw new Error('path must be a non-empty relative file path');
  const realRoot = realpathSync(root);
  const errorMessage = () => `path resolves outside your writable session area (${realRoot})`;
  if (isAbsolute(input)) throw new Error(errorMessage());
  const candidate = resolve(realRoot, input);
  if (!withinRoot(realRoot, candidate)) throw new Error(errorMessage());
  let existingAncestor = dirname(candidate);
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error(errorMessage());
    existingAncestor = parent;
  }
  const realAncestor = realpathSync(existingAncestor);
  if (realAncestor !== realRoot && !withinRoot(realRoot, realAncestor)) {
    throw new Error(errorMessage());
  }
  if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
    throw new Error(`refusing to write through a symlink (${realRoot})`);
  }
  mkdirSync(dirname(candidate), { recursive: true });
  return candidate;
}

export async function writeScratchFile(
  args: JsonObject,
  deps: WriteScratchFileDeps = writeScratchFileDepsFromEnv(),
): Promise<string> {
  const path = stringArg(args, 'path');
  if (!path) throw new Error('path must be a non-empty relative file path');
  const content = args.content;
  if (typeof content !== 'string') throw new Error('content must be a string');
  const encoding = args.encoding;
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
    throw new Error('encoding must be "utf8" or "base64"');
  }
  const bytes = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
  if (bytes.length > MAX_ATTACH_BYTES) {
    throw new Error(`content exceeds the ${MAX_ATTACH_BYTES}-byte attachment limit`);
  }
  const resolved = resolveWriteScratchPath(deps.root, path);
  writeFileSync(resolved, bytes);
  return `Wrote ${bytes.length} bytes to ${resolved}; post_artifact with this path sends it.`;
}

const FETCH_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type FetchImageMime = (typeof FETCH_IMAGE_MIMES)[number];

export interface FetchImageDeps {
  /** Same writable session area write_scratch_file and post_artifact use. */
  root: string;
  fetchImpl?: typeof fetch;
}

export function fetchImageDepsFromEnv(): FetchImageDeps {
  return { root: requiredEnv('BEELINE_ATTACH_SCRATCH_ROOT') };
}

function parseImageUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('url must be an http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must be an http(s) URL');
  }
  return parsed;
}

function sniffRasterImageMime(bytes: Buffer): FetchImageMime | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

function resolveFetchedImageMime(contentType: string, bytes: Buffer): FetchImageMime {
  if (contentType === 'image/svg+xml' || contentType.startsWith('image/svg')) {
    throw new Error('fetch_image is for photographs, not SVG; embed a JPEG or PNG as a data: URL');
  }
  if ((FETCH_IMAGE_MIMES as readonly string[]).includes(contentType)) {
    return contentType as FetchImageMime;
  }
  if (!contentType || contentType === 'application/octet-stream') {
    const sniffed = sniffRasterImageMime(bytes);
    if (sniffed) return sniffed;
  }
  throw new Error(
    `response is not a photograph (${contentType || 'unknown type'}); fetch_image accepts JPEG, PNG, GIF, and WebP`,
  );
}

function fetchedImageFileName(url: URL, mime: FetchImageMime): string {
  const ext =
    mime === 'image/jpeg'
      ? '.jpg'
      : mime === 'image/png'
        ? '.png'
        : mime === 'image/gif'
          ? '.gif'
          : '.webp';
  const raw = basename(url.pathname)
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '');
  if (raw && /\.(jpe?g|png|gif|webp)$/i.test(raw)) return raw;
  if (raw) return raw.toLowerCase().endsWith(ext) ? raw : `${raw}${ext}`;
  return `photo${ext}`;
}

/** fetch_image: daemon-side photograph download into session scratch. */
export async function fetchImage(
  args: JsonObject,
  deps: FetchImageDeps = fetchImageDepsFromEnv(),
): Promise<string> {
  const url = stringArg(args, 'url')?.trim();
  if (!url) throw new Error('url must be a non-empty http(s) URL');
  const parsed = parseImageUrl(url);
  let fetched;
  try {
    fetched = await fetchBoundedBytes(parsed.href, deps.fetchImpl ?? fetch);
  } catch (error) {
    if (error instanceof BoundedSizeError) {
      throw new Error(
        `image exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit (${error.bytes} bytes)`,
      );
    }
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`image fetch timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (!fetched.ok) {
    throw new Error(`image fetch failed: HTTP ${fetched.status}`);
  }
  if (fetched.bytes.length === 0) throw new Error('image fetch returned no bytes');
  const mime = resolveFetchedImageMime(fetched.mimeType, fetched.bytes);
  const resolved = resolveWriteScratchPath(
    deps.root,
    join('fetched-images', fetchedImageFileName(parsed, mime)),
  );
  writeFileSync(resolved, fetched.bytes);
  return JSON.stringify({ path: resolved, mime, size: fetched.bytes.length });
}

function withinRoot(root: string, resolved: string): boolean {
  const rel = relative(root, resolved);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve a post_artifact `path` inside the session checkout or anywhere in
 *  the session's writable home overlay (wherever a harness put a file it
 *  generated), never following a symlink outside either root. Returns the
 *  real path of an existing regular file. A relative `input` is tried
 *  against each root in order, taking the first that exists; the escape
 *  check then requires the real path land inside at least one of the
 *  roots. */
export function resolveAttachPath(roots: string[], input: string): string {
  if (!input || input.includes('\0')) throw new Error('path must be a non-empty file path');
  if (!roots.length) throw new Error('no attachment roots are configured');
  const realRoots = roots.map((root) => realpathSync(root));
  const errorMessage = () =>
    `path resolves outside your checkout or writable session home (${realRoots.join(', ')})`;
  const resolveAgainst = (candidate: string): string => {
    const resolved = realpathSync(candidate);
    if (!realRoots.some((root) => withinRoot(root, resolved))) throw new Error(errorMessage());
    return resolved;
  };
  if (isAbsolute(input)) return finishResolvedAttachPath(resolveAgainst(input));
  let notFoundError: unknown;
  for (const root of realRoots) {
    const candidate = resolve(root, input);
    if (!existsSync(candidate)) {
      notFoundError ??= new Error(`no such file: ${input}`);
      continue;
    }
    return finishResolvedAttachPath(resolveAgainst(candidate));
  }
  throw notFoundError instanceof Error ? notFoundError : new Error(errorMessage());
}

function finishResolvedAttachPath(resolved: string): string {
  if (!statSync(resolved).isFile()) throw new Error('path is not a regular file');
  return resolved;
}

/** The daemon-facing artifacts pass-through's response: `postArtifact` only
 *  reads `url`, the rest of `UploadArtifactResult`
 *  (`apps/server/src/object-service.ts`) rides along unused. */
export interface DaemonArtifactUploadResult {
  url: string;
  mimeType?: string;
  size?: number;
  title?: string;
}

export interface PostArtifactDeps {
  roomId: string;
  /** Legal source roots for the `path` argument: the session checkout and
   *  (when configured) the session's whole writable home overlay, wherever
   *  the harness put a file it generated. */
  roots: string[];
  upload: (bytes: Buffer, mime: string, title: string) => Promise<DaemonArtifactUploadResult>;
  queue: (attachment: JsonObject) => Promise<void>;
}

function isArtifactMime(value: unknown): value is ArtifactMimeType {
  return typeof value === 'string' && (ARTIFACT_MIME_TYPES as readonly string[]).includes(value);
}

export function postArtifactDepsFromEnv(): PostArtifactDeps {
  const scratchRoot = process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim();
  return {
    roomId: agentScheduleRoomId(),
    roots: [requiredEnv('BEELINE_ATTACH_ROOT'), ...(scratchRoot ? [scratchRoot] : [])],
    upload: (bytes, mime, title) => daemonUploadArtifact(bytes, mime, title),
    queue: async (attachment) => {
      await daemonExecute('postAgentAttachment', { roomId: agentScheduleRoomId(), attachment });
    },
  };
}

/** post_artifact: validate, upload through the artifacts pass-through, then
 *  queue the attachment on this turn's final reply. Content comes either
 *  from `path` (a file in the session checkout or writable home, with title
 *  and mime defaulted) or from `html`/`bytes` inline. The server refuses the
 *  attachment outside an active turn (postAgentAttachment is turn-authority
 *  bound), so there is no separate surface-side turn check here. */
export async function postArtifact(
  args: JsonObject,
  deps: PostArtifactDeps = postArtifactDepsFromEnv(),
): Promise<string> {
  const pathArg = stringArg(args, 'path');
  const html = args.html;
  const encoded = args.bytes;
  const contentArgs = (html !== undefined ? 1 : 0) + (encoded !== undefined ? 1 : 0);
  if (pathArg !== undefined && contentArgs > 0) {
    throw new Error(
      'pass either path (a file already in your session) or html/bytes content, not both',
    );
  }
  if (contentArgs > 1) {
    throw new Error('pass html (the document as text) or bytes (base64), not both');
  }
  if (pathArg === undefined && contentArgs === 0) {
    throw new Error(
      'pass a file path, or exactly one of html (the document as text) or bytes (base64)',
    );
  }
  let bytes: Buffer;
  let fileName: string;
  if (pathArg !== undefined) {
    const resolved = resolveAttachPath(deps.roots, pathArg);
    const details = statSync(resolved);
    if (details.size > MAX_ATTACH_BYTES) {
      throw new Error(`file exceeds the ${MAX_ATTACH_BYTES}-byte artifact limit`);
    }
    bytes = readFileSync(resolved);
    fileName = resolved.split(sep).pop() ?? 'artifact';
  } else {
    if (html !== undefined) {
      if (typeof html !== 'string') throw new Error('html must be a string');
      bytes = Buffer.from(html, 'utf8');
    } else {
      if (typeof encoded !== 'string') throw new Error('bytes must be a base64 string');
      bytes = Buffer.from(encoded, 'base64');
    }
    fileName = 'artifact';
  }
  let mime = stringArg(args, 'mime');
  if (mime === undefined) {
    const extension = fileName.includes('.')
      ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
      : '';
    mime = ARTIFACT_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
  }
  if (!isArtifactMime(mime)) {
    throw new Error(`mime must be one of ${ARTIFACT_MIME_TYPES.join(', ')}`);
  }
  let title = stringArg(args, 'title')?.trim();
  if (!title) {
    if (pathArg === undefined) {
      throw new Error(
        'title must be a non-empty string (or post by path to default it to the file name)',
      );
    }
    title = fileName;
  }
  if (title.length > 200) throw new Error('title must be at most 200 characters');
  validateArtifact(mime, bytes, title);
  const uploaded = await deps.upload(bytes, mime, title);
  if (!uploaded.url) throw new Error('the artifact upload returned no url');
  await deps.queue({ url: uploaded.url, name: title, mimeType: mime, size: bytes.length });
  return (
    `Posted artifact "${title}" (${bytes.length} bytes, ${mime}); it is delivered with your ` +
    'final reply. Ask for feedback here in the Room.'
  );
}

function agentScheduleRoomId(): string {
  return process.env.BEELINE_DAEMON_CORNER_ID?.trim() || requiredEnv('BEELINE_DAEMON_ROOM_ID');
}

const MIN_SCHEDULE_MINUTES = 1;

function parseScheduleCadence(args: JsonObject): {
  cadence: JsonObject;
  floored: boolean;
  describe: () => string;
} {
  const cadence = asObject(args.cadence);
  const kind = stringArg(cadence, 'kind');
  if (kind === 'interval') {
    const requested = cadence.everyMinutes;
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
      throw new Error('everyMinutes must be a positive number of minutes');
    }
    const everyMinutes = Math.max(MIN_SCHEDULE_MINUTES, Math.round(requested));
    return {
      cadence: { kind: 'interval', everyMinutes },
      floored: everyMinutes !== requested,
      describe: () => `every ${everyMinutes} minute${everyMinutes === 1 ? '' : 's'}`,
    };
  }
  if (kind === 'cron') {
    const expression = stringArg(cadence, 'expression');
    if (!expression || expression.trim().split(/\s+/).length !== 5) {
      throw new Error('cron expression must have five fields');
    }
    const timeZone = stringArg(cadence, 'timeZone');
    return {
      cadence: { kind: 'cron', expression: expression.trim(), ...(timeZone ? { timeZone } : {}) },
      floored: false,
      describe: () => `cron '${expression.trim()}'`,
    };
  }
  throw new Error('cadence kind must be interval or cron');
}

export interface AgentScheduleDeps {
  roomId: string;
  execute: (name: string, input: JsonObject) => Promise<JsonObject>;
}

export function agentScheduleDepsFromEnv(): AgentScheduleDeps {
  return { roomId: agentScheduleRoomId(), execute: daemonExecute };
}

export async function reactToMessage(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const messageId = stringArg(args, 'messageId')?.trim();
  if (!messageId) throw new Error('messageId must be a non-empty string');
  const emoji = stringArg(args, 'emoji');
  if (!emoji || !(MESSAGE_REACTION_EMOJIS as readonly string[]).includes(emoji)) {
    throw new Error(`emoji must be one of ${MESSAGE_REACTION_EMOJIS.join(' ')}`);
  }
  await deps.execute('reactToRoomMessage', {
    roomId: deps.roomId,
    messageId,
    emoji: emoji as MessageReactionEmoji,
  });
  return `Reacted ${emoji} to message ${messageId}.`;
}

export async function createSchedule(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const prompt = stringArg(args, 'prompt')?.trim();
  if (!prompt) throw new Error('prompt must be a non-empty string');
  if (prompt.length > 2000) throw new Error('prompt exceeds 2000 characters');
  const { cadence, floored, describe } = parseScheduleCadence(args);
  const maxRuns = args.maxRuns;
  if (
    maxRuns !== undefined &&
    (typeof maxRuns !== 'number' || !Number.isInteger(maxRuns) || maxRuns < 1)
  ) {
    throw new Error('maxRuns must be a positive integer');
  }
  const created = await deps.execute('createAgentSchedule', {
    roomId: deps.roomId,
    prompt,
    cadence,
    ...(maxRuns !== undefined ? { maxRuns } : {}),
  });
  const scheduleId = typeof created.scheduleId === 'string' ? created.scheduleId : 'unknown';
  const floorNote = floored
    ? ` The minimum cadence is ${MIN_SCHEDULE_MINUTES} minute; created every ${MIN_SCHEDULE_MINUTES} minute.`
    : '';
  return (
    `Schedule ${scheduleId} created: ${describe()}` +
    (maxRuns !== undefined ? `, ${maxRuns} run${maxRuns === 1 ? '' : 's'}` : '') +
    `; the prompt runs as a mention to you in this Room.` +
    floorNote +
    ' Use delete_schedule with this scheduleId to remove it.'
  );
}

export async function listSchedules(
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const result = await deps.execute('listAgentSchedules', { roomId: deps.roomId });
  const schedules = Array.isArray(result.schedules) ? result.schedules : [];
  if (!schedules.length) return 'No schedules in this Room.';
  return schedules
    .flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const schedule = entry as Record<string, unknown>;
      const cadence =
        schedule.cadence && typeof schedule.cadence === 'object'
          ? (schedule.cadence as Record<string, unknown>)
          : {};
      const cadenceText =
        cadence.kind === 'interval'
          ? `every ${String(cadence.everyMinutes)} minute(s)`
          : `cron '${String(cadence.expression)}'`;
      const runs =
        typeof schedule.maxRuns === 'number'
          ? ` (${String(schedule.runCount ?? 0)}/${String(schedule.maxRuns)} runs)`
          : ` (${String(schedule.runCount ?? 0)} runs)`;
      const nextRunAt =
        typeof schedule.nextRunAt === 'number'
          ? `, next run ${new Date(schedule.nextRunAt * 1_000).toISOString()}`
          : '';
      return [
        `${String(schedule.scheduleId)}: ${cadenceText}${runs}${nextRunAt} — ${String(schedule.prompt)}`,
      ];
    })
    .join('\n');
}

/**
 * The agent's own event subscriptions, written by the agent.
 *
 * A subscription is per Room and belongs to the agent's own membership row, so
 * the tool sends kinds and nothing else: the daemon token names the agent and
 * the environment names the Room. The reply always states the COMPLETE
 * resulting list, because the write replaces rather than adds and a model that
 * subscribed to one more kind must be able to see what it stopped reacting to.
 */
export async function subscribeEvents(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const requested = args.kinds;
  if (!Array.isArray(requested))
    throw new Error(`kinds must be an array of event kinds: ${SERVER_EVENT_KINDS.join(', ')}`);
  const unknown = requested.filter((kind) => !isServerEventKind(kind));
  if (unknown.length) {
    throw new Error(
      `not an event kind you can subscribe to: ${unknown.map(String).join(', ')}. ` +
        `The kinds are ${SERVER_EVENT_KINDS.join(', ')}.`,
    );
  }
  const result = await deps.execute('setEventSubscriptions', {
    roomId: deps.roomId,
    kinds: requested as string[],
  });
  return describeSubscriptions(result, 'You now react to');
}

export async function listEventSubscriptions(
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const result = await deps.execute('listEventSubscriptions', { roomId: deps.roomId });
  return describeSubscriptions(result, 'You react to');
}

function describeSubscriptions(result: JsonObject, lead: string): string {
  const kinds = (Array.isArray(result.kinds) ? result.kinds : []).map(String);
  return kinds.length
    ? `${lead} ${kinds.join(', ')} in this Room; each one wakes you for a turn.`
    : 'You react to no events in this Room; only a message that mentions you wakes you.';
}

/**
 * One event this agent emits into the Room it is answering in.
 *
 * The tool sends no cause: the server reads this agent's live turn receipt and
 * derives the chain from it. A refusal — too deep, or a chain that has woken
 * too many turns — comes back as this tool's error, which is the only way the
 * emitting model learns that nothing was posted.
 */
export async function emitEvent(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const kind = stringArg(args, 'kind')?.trim();
  if (!kind) throw new Error('kind must be a non-empty string');
  if (isServerEventKind(kind)) {
    throw new Error(
      `${kind} is a fact the server states, not one you emit. Use an agent:<slug> kind of your own.`,
    );
  }
  if (!isAgentKind(kind)) {
    throw new Error(
      'kind must be agent:<slug>, lower-case letters, digits and hyphens, at most 40 characters',
    );
  }
  const consequence = stringArg(args, 'consequence')?.trim();
  if (!consequence) throw new Error('consequence must say in one sentence what happened');
  if (consequence.length > MAX_EVENT_CONSEQUENCE_LENGTH)
    throw new Error(`consequence must be at most ${MAX_EVENT_CONSEQUENCE_LENGTH} characters`);
  const mentions = args.mentionAgentIds;
  if (mentions !== undefined && !Array.isArray(mentions))
    throw new Error('mentionAgentIds must be an array of agent ids');
  const mentionAgentIds = (mentions ?? []).map(String);
  if (mentionAgentIds.length > MAX_MENTIONS_PER_EVENT)
    throw new Error(`an event may wake at most ${MAX_MENTIONS_PER_EVENT} agents`);
  await deps.execute('postRoomEvent', {
    roomId: deps.roomId,
    kind,
    consequence,
    ...(mentionAgentIds.length ? { mentionAgentIds } : {}),
  });
  return mentionAgentIds.length
    ? `Posted ${kind} in this Room and woke ${mentionAgentIds.length} agent(s).`
    : `Posted ${kind} in this Room.`;
}

export async function deleteSchedule(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const scheduleId = stringArg(args, 'scheduleId')?.trim();
  if (!scheduleId) throw new Error('scheduleId must be a non-empty string');
  await deps.execute('deleteAgentSchedule', { roomId: deps.roomId, scheduleId });
  return `Schedule ${scheduleId} deleted.`;
}

export interface AgentGrantDeps {
  roomId: string;
  execute: (name: string, input: JsonObject) => Promise<JsonObject>;
  /** Where a script argument may be read from: the checkout, then the scratch. */
  scriptRoots?: string[];
  /** Test seam for reading those bytes. */
  readScript?: (path: string) => Buffer;
}

export function agentGrantDepsFromEnv(): AgentGrantDeps {
  const scratchRoot = process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim();
  const attachRoot = process.env.BEELINE_ATTACH_ROOT?.trim();
  return {
    roomId: agentScheduleRoomId(),
    execute: daemonExecute,
    scriptRoots: [...(attachRoot ? [attachRoot] : []), ...(scratchRoot ? [scratchRoot] : [])],
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
  const argument = interpreterScriptArgument(rule.argv);
  if (!argument) return undefined;
  const roots = deps.scriptRoots ?? [];
  if (!roots.length) return undefined;
  let resolved: string;
  try {
    resolved = resolveAttachPath(roots, argument.path);
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
  const kind = stringArg(args, 'kind');
  if (!isAgentGrantKind(kind)) {
    throw new Error(`kind must be one of ${AGENT_GRANT_KINDS.join(', ')}`);
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
  const result = await deps.execute('requestAgentGrant', {
    roomId: deps.roomId,
    kind,
    target,
    reason,
    ...(ttl !== undefined ? { ttlSeconds: ttl } : {}),
    ...(script ? { script } : {}),
  });
  const grantId = typeof result.grantId === 'string' ? result.grantId : 'unknown';
  const ask = `${AGENT_GRANT_VERBS[kind]} ${target}`;
  if (result.auto === true) {
    return kind === 'command'
      ? `approved (yolo): ${ask} [grant ${grantId}]. Run it now with run_granted_command and the argv.`
      : `approved (yolo): ${ask} [grant ${grantId}]; applies at the agent's next session.`;
  }
  // Yolo covers most asks; these two shapes never do, and saying which one this
  // is stops the model retrying the same line expecting a different answer.
  const escalations = Array.isArray(result.escalations)
    ? (result.escalations as AgentGrantEscalation[])
    : [];
  const because = formatGrantEscalationReason(escalations);
  return (
    `pending, card posted: ${ask} [grant ${grantId}]. ` +
    (because ? `A human always answers this one because ${because}. ` : '') +
    (script
      ? `The card shows ${script.path} in full, and the approval is bound to those bytes. `
      : '') +
    (kind === 'mcp' && target === 'squire'
      ? 'Your owner must answer ALWAYS, ONCE, or NO in the Trusty Squire DM; '
      : 'Your owner must answer ALWAYS, ONCE, or NO in this Room; ') +
    'your turn is paused on this grant. Tell the human what you are waiting for and end your turn now; ' +
    (kind === 'mcp'
      ? 'the approval wake starts the fresh session with that route mounted, so use it immediately without restarting or scheduling another turn.'
      : 'you will be woken with the answer.')
  );
}

export interface ConnectorOfferDeps {
  roomId: string;
  execute: (name: string, input: JsonObject) => Promise<JsonObject>;
}

export function connectorOfferDepsFromEnv(): ConnectorOfferDeps {
  return { roomId: agentScheduleRoomId(), execute: daemonExecute };
}

/**
 * workbench_status: the Workbench as it stands for the person this turn
 * answers, rendered as text the model reads line by line — a tool it may
 * offer, a tool already paired (and where), a connection by name.
 */
export async function workbenchStatus(
  deps: ConnectorOfferDeps = connectorOfferDepsFromEnv(),
): Promise<string> {
  const view = (await deps.execute('readAgentWorkbench', { roomId: deps.roomId })) as {
    addressee?: { name?: string; handle?: string };
    catalog?: Array<{
      connectorType: string;
      name: string;
      purpose: string;
      available: boolean;
      offerable: boolean;
      paired?: { status: string; helperName: string; onThisMachine: boolean };
    }>;
    connections?: Array<{
      connectorType: string;
      service: string | null;
      label: string;
      state: string;
    }>;
    machine?: { machineId: string; name: string };
  };
  const who = view.addressee?.handle
    ? `@${view.addressee.handle}`
    : (view.addressee?.name ?? 'the person you are answering');
  const lines = [
    `Workbench for ${who} (an accepted offer installs on your machine, ${view.machine?.name ?? 'this machine'}).`,
    '',
    'Catalog:',
  ];
  for (const entry of view.catalog ?? []) {
    const state = entry.paired
      ? `${entry.paired.status} on ${entry.paired.helperName}${entry.paired.onThisMachine ? ' (your machine)' : ''}`
      : !entry.available
        ? 'not available yet'
        : entry.offerable
          ? 'not added — you may offer it with offer_connector'
          : 'not added — added only from the Workbench page';
    lines.push(`- ${entry.connectorType} (${entry.name}): ${state}. ${entry.purpose}`);
  }
  lines.push('', 'Connections (keys already provisioned, by name only):');
  const connections = view.connections ?? [];
  if (!connections.length) lines.push('- none');
  for (const connection of connections)
    lines.push(
      `- ${connection.label}${connection.service ? ` (${connection.service})` : ''} via ${connection.connectorType}${connection.state === 'error' ? ' — in error' : ''}`,
    );
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
      `connectorType must be one of ${OFFERABLE_CONNECTOR_KINDS.join(', ')} (see workbench_status)`,
    );
  }
  const reason = stringArg(args, 'reason')?.trim().replace(/\s+/g, ' ');
  if (!reason) throw new Error('reason must be a non-empty string');
  if (reason.length > CONNECTOR_OFFER_REASON_MAX_LENGTH) throw new Error('reason is too long');
  const result = await deps.execute('offerConnector', {
    roomId: deps.roomId,
    connectorType,
    reason,
  });
  const offerId = typeof result.offerId === 'string' ? result.offerId : 'unknown';
  const joined = result.joined === true;
  return (
    `${joined ? 'already offered, card still open' : 'pending, card posted'}: add ${connectorType} [offer ${offerId}]. ` +
    'The person you addressed, or a Workspace admin, can accept it with the one action on the card; ' +
    'your turn is paused on this offer. In prose, say what you learned about the tool and that you are waiting for them to add it, then end your turn now; ' +
    'you will be woken when it is added. Do not ask them to open Settings or the Workbench page — the card is the whole ask.'
  );
}

function choiceOptionArgs(args: JsonObject): Array<{
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

export function grantRunDepsFromEnv(): GrantRunDeps {
  return {
    roomId: agentScheduleRoomId(),
    run: async (input) => {
      const baseUrl = requiredEnv('BEELINE_GRANT_RUNNER_URL');
      const response = await fetch(new URL('/run', `${baseUrl}/`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${requiredEnv('BEELINE_GRANT_RUNNER_TOKEN')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      });
      const body = (await response.json().catch(() => ({}))) as JsonObject;
      if (!response.ok) {
        throw new Error(
          typeof body.error === 'string' ? body.error : `grant runner failed (${response.status})`,
        );
      }
      return body;
    },
  };
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
      ? '\nThis Room is read-only outside your scratch directory. Open a corner with open_corner to change files.'
      : '';
  return `ran under grant ${grantId}: ${verdict}\n${output}${refused}`;
}

/** The small-object pass-through: the server validates and streams the
 *  bytes to storage in one step and answers with the stored artifact url. */
async function daemonUploadArtifact(
  bytes: Buffer,
  mime: string,
  title: string,
): Promise<DaemonArtifactUploadResult> {
  const baseUrl = requiredEnv('BEELINE_DAEMON_BASE_URL');
  const response = await fetch(new URL('/v1/daemon/artifacts', `${baseUrl}/`), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requiredEnv('BEELINE_DAEMON_TOKEN')}`,
      'content-type': mime,
      'x-artifact-title': title,
    },
    body: bytes,
  });
  if (!response.ok) {
    let code = 'request_failed';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') code = body.error;
    } catch {
      // Never reflect a server body into the model-facing tool error.
    }
    throw new Error(`artifact upload failed (${response.status}: ${code})`);
  }
  const body = (await response.json()) as JsonObject;
  return {
    url: typeof body.url === 'string' ? body.url : '',
    mimeType: typeof body.mimeType === 'string' ? body.mimeType : mime,
    size: typeof body.size === 'number' ? body.size : bytes.length,
    title: typeof body.title === 'string' ? body.title : title,
  };
}

async function callAgentTool(name: string, args: JsonObject, toolCallId: string): Promise<string> {
  switch (name) {
    case 'wallet_address':
      return JSON.stringify(await daemonExecute('getWalletToolState', { agentId: 'self' }));
    case 'wallet_balance':
      return JSON.stringify(await daemonExecute('getWalletToolBalance', { agentId: 'self' }));
    case 'wallet_chains':
      return JSON.stringify(await daemonExecute('getWalletToolChains', { agentId: 'self' }));
    case 'wallet_history':
      return JSON.stringify(
        await daemonExecute('getWalletToolHistory', {
          agentId: 'self',
          ...(typeof args.limit === 'number' ? { limit: Math.floor(args.limit) } : {}),
        }),
      );
    case 'wallet_quote':
      return JSON.stringify(
        await daemonExecute('getWalletToolQuote', {
          agentId: 'self',
          ...(typeof args.chain === 'string' ? { chain: args.chain } : {}),
          asset: String(args.asset ?? 'usdc'),
          amount: String(args.amount ?? ''),
        }),
      );
    case 'wallet_pay':
      return JSON.stringify(
        await daemonExecute('walletPay', {
          agentId: 'self',
          ...(typeof args.chain === 'string' ? { chain: args.chain } : {}),
          asset: String(args.asset ?? 'usdc'),
          amount: String(args.amount ?? ''),
          to: String(args.to ?? ''),
        }),
      );
    case 'wallet_swap':
      return JSON.stringify(
        await daemonExecute('walletSwap', {
          agentId: 'self',
          ...(typeof args.chain === 'string' ? { chain: args.chain } : {}),
          fromAsset: String(args.fromAsset ?? 'usdc'),
          toAsset: String(args.toAsset ?? 'eth'),
          amount: String(args.amount ?? ''),
        }),
      );
    case 'open_corner':
      return openCorner(args, toolCallId);
    case 'steer_corner':
      return relayMessage('down', args);
    case 'ask_corner':
      return relayMessage('down', args, true);
    case 'get_corner_ask': {
      if (process.env.BEELINE_AGENT_DM === '1' || process.env.BEELINE_DAEMON_CORNER_ID)
        throw new Error('get_corner_ask requires a Room turn');
      if (typeof args.askId !== 'string' || !args.askId) throw new Error('askId is required');
      return JSON.stringify(
        await daemonExecute('getCornerAsk', {
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          askId: args.askId,
        }),
      );
    }
    case 'inspect_corner': {
      if (process.env.BEELINE_AGENT_DM === '1' || process.env.BEELINE_DAEMON_CORNER_ID)
        throw new Error('inspect_corner requires a Room turn');
      const roomId = requiredEnv('BEELINE_DAEMON_ROOM_ID');
      if (typeof args.cornerId !== 'string' || !args.cornerId)
        throw new Error('cornerId is required');
      if (args.after !== undefined && (typeof args.after !== 'string' || !args.after))
        throw new Error('after must be a nonempty cursor');
      if (args.mode !== undefined && args.mode !== 'status' && args.mode !== 'transcript')
        throw new Error('mode must be status or transcript');
      if (args.after && args.mode !== 'transcript')
        throw new Error('after requires transcript mode');
      if (
        args.offset !== undefined &&
        (!Number.isSafeInteger(args.offset) ||
          (args.offset as number) < 0 ||
          args.mode !== 'transcript')
      )
        throw new Error('offset requires transcript mode and a nonnegative safe integer');
      const corners = await daemonExecute('listRoomCorners', { roomId });
      if (
        !Array.isArray(corners.corners) ||
        !corners.corners.some(
          (corner) =>
            corner &&
            typeof corner === 'object' &&
            (corner as Record<string, unknown>).cornerId === args.cornerId,
        )
      )
        throw new Error('corner is not available in this Room');
      if (args.mode === 'transcript') {
        const page = (await daemonExecute('getRoomConversation', {
          roomId: args.cornerId,
          limit: 9,
          ...(args.after ? { after: args.after } : { window: 'earliest' }),
        })) as unknown as RoomConversationResult;
        const items: Record<string, unknown>[] = [];
        let nextAfter = args.after as string | undefined;
        let nextOffset = args.offset as number | undefined;
        let hasMore = false;
        for (const item of page.items.slice(0, 8)) {
          const offset = nextOffset ?? 0;
          if (offset > item.body.length) throw new Error('offset exceeds message body');
          let body = item.body.slice(offset, offset + 1000);
          const row = {
            id: item.id,
            cursor: item.cursor,
            authorId: item.authorId,
            createdAt: item.createdAt,
            type: item.type,
            ...(offset ? { bodyOffset: offset } : {}),
            ...(item.attachments.length ? { attachmentCount: item.attachments.length } : {}),
          };
          // Escaped control characters can occupy six JSON characters each.
          while (body && JSON.stringify([...items, { ...row, body }]).length > 11000)
            body = body.slice(0, Math.floor(body.length / 2));
          if (!body && item.body.length > offset) {
            hasMore = true;
            break;
          }
          items.push({
            ...row,
            body,
            ...(offset + body.length < item.body.length ? { bodyContinues: true } : {}),
          });
          if (offset + body.length < item.body.length) {
            nextOffset = offset + body.length;
            hasMore = true;
            break;
          }
          nextAfter = item.cursor;
          nextOffset = undefined;
        }
        if (!hasMore) hasMore = page.items.length > items.length;
        return JSON.stringify({
          cornerId: args.cornerId,
          items,
          ...(hasMore
            ? {
                next: {
                  ...(nextAfter ? { after: nextAfter } : {}),
                  ...(nextOffset ? { offset: nextOffset } : {}),
                },
              }
            : {}),
          limits: { items: 8, bodyChars: 1000, responseChars: 12000 },
        });
      }
      const status = (await daemonExecute('getCornerRestoreState', {
        cornerId: args.cornerId,
      })) as unknown as CornerRestoreResult;
      const pr = status.lifecycle?.pr;
      // GitHub can be unavailable while the server-owned lifecycle remains readable.
      const verdict = pr
        ? await daemonExecute('getPrChecksStatus', {
            cornerId: args.cornerId,
            pullRequest: pr.number,
          }).catch(() => undefined)
        : undefined;
      return JSON.stringify({
        cornerId: args.cornerId,
        state: status.lifecycle?.lifecycle ?? 'unknown',
        ...(pr ? { pr: { number: pr.number, url: pr.url, title: pr.title } } : {}),
        ...(verdict?.headSha || pr?.headSha ? { head: verdict?.headSha ?? pr?.headSha } : {}),
        checks: verdict?.checks ?? status.lifecycle?.checks ?? 'unknown',
        verdict: verdict
          ? {
              approvalPending: verdict.approvalPending,
              reviewer: verdict.reviewer,
              reviewerExists: verdict.reviewerExists,
              reviewerIsAuthor: verdict.reviewerIsAuthor,
              reviewerWake: verdict.reviewerWake,
            }
          : { approvalPending: true, status: 'unavailable' },
        merge: {
          mergeability: pr?.mergeability ?? 'unknown',
          ...(pr?.mergedAt ? { mergedAt: pr.mergedAt } : {}),
          // This read lacks the worker's yolo setting and the latest human hold.
          // It must never imply that a passing reviewer verdict authorizes a merge.
          authorization: 'check pr_checks_status in the corner',
        },
      });
    }
    case 'react_to_message':
      return reactToMessage(args);
    case 'close_corner':
      return closeCorner();
    case 'pr_checks_status':
      return prChecksStatus(args);
    case 'approve_merge':
      return approveMerge(args);
    case 'write_scratch_file':
      return writeScratchFile(args);
    case 'fetch_image':
      return fetchImage(args);
    case 'post_artifact':
      return postArtifact(args);
    case 'publish_corner_app': {
      const cornerId = process.env.BEELINE_DAEMON_CORNER_ID?.trim();
      if (!cornerId) throw new Error('publish_corner_app requires a corner turn');
      const result = await daemonExecute('putCornerApp', {
        cornerId,
        definition: {
          version: 1,
          slug: args.slug,
          title: args.title,
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          command: args.command,
          blocks: args.blocks,
        },
      });
      return `published /${String(args.command)} at revision ${String(result.revision ?? '?')}`;
    }
    case 'open_corner_app': {
      const cornerId = process.env.BEELINE_DAEMON_CORNER_ID?.trim();
      if (!cornerId) throw new Error('open_corner_app requires a corner turn');
      const context = await activeCommandContext();
      const result = await daemonExecute('requestCornerAppOpen', {
        cornerId,
        slug: args.slug,
        requestId: context.requestId,
      });
      return `posted app ${String(result.slug ?? args.slug)} at revision ${String(result.revision ?? '?')}`;
    }
    case 'create_schedule':
      return createSchedule(args);
    case 'subscribe_events':
      return subscribeEvents(args);
    case 'list_event_subscriptions':
      return listEventSubscriptions();
    case 'emit_event':
      return emitEvent(args);
    case 'list_schedules':
      return listSchedules();
    case 'delete_schedule':
      return deleteSchedule(args);
    case 'request_grant':
      return requestGrant(args);
    case 'workbench_status':
      return workbenchStatus();
    case 'offer_connector':
      return offerConnector(args);
    case 'ask_choice':
      return askChoice(args);
    case 'open_poll':
      return openPoll(args);
    case 'run_granted_command':
      return runGrantedCommand(args);
    default:
      throw new Error(`tool is not available on the agent surface: ${name}`);
  }
}

function toolCallId(params: JsonObject, requestId: JsonRpcRequest['id']): string {
  const metadata = asObject(params._meta);
  const candidate = metadata.beelineToolCallId ?? metadata.progressToken ?? requestId;
  return typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : '';
}

function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(id: JsonRpcRequest['id'], result: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, result });
}

function failure(id: JsonRpcRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

async function handleLine(line: string): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    failure(null, -32700, 'invalid JSON');
    return;
  }
  if (request.id === undefined) return;
  try {
    if (request.method === 'initialize') {
      const params = asObject(request.params);
      success(request.id, {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: youtubeSurface
            ? YOUTUBE_MCP_SERVER_NAME
            : agentSurface
              ? 'beeline-agent'
              : 'beeline-readonly-mcp',
          version: '1.0.0',
        },
      });
      return;
    }
    if (request.method === 'ping') {
      success(request.id, {});
      return;
    }
    if (request.method === 'tools/list') {
      success(request.id, { tools: TOOLS });
      return;
    }
    if (request.method === 'tools/call') {
      const params = asObject(request.params);
      if (typeof params.name !== 'string') throw new Error('tool name must be a string');
      // A tool that refuses answers with an MCP tool RESULT carrying isError,
      // not a JSON-RPC protocol error. A protocol error is a client bug in
      // every harness that reads the spec, and reaches the model - when it
      // reaches it at all - as "the call failed", with the sentence explaining
      // why buried in a transport frame (C90).
      let output: string;
      try {
        output = youtubeSurface
          ? await callYoutubeTool(
              params.name,
              asObject(params.arguments),
              youtubeClientFromToken(process.env.BEELINE_YOUTUBE_ACCESS_TOKEN ?? ''),
            )
          : agentSurface
            ? await callAgentTool(
                params.name,
                asObject(params.arguments),
                toolCallId(params, request.id),
              )
            : callTool(params.name, asObject(params.arguments));
      } catch (error) {
        success(request.id, {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
        return;
      }
      success(request.id, { content: [{ type: 'text', text: output }] });
      return;
    }
    failure(request.id, -32601, `method not found: ${request.method ?? ''}`);
  } catch (error) {
    failure(request.id, -32602, error instanceof Error ? error.message : String(error));
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => void handleLine(line));
