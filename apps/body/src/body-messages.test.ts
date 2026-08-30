/**
 * Hermetic unit tests for body modules.
 * These tests do NOT require a relay or LLM endpoint.
 */
import { afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasWriteTools, inventoryForMcpServers } from './mcp-inventory.js';
import { parseEnvFile, hasLlmCredentials, type BodyConfig } from './config.js';
import { prepareCornerAgentPrivateState } from './agent-private-state.js';
import { mediaUploadResponse, relayQueryResponse } from './relay-test-helper.js';

const mocks = vi.hoisted(() => ({
  createBuzzClient: vi.fn(),
  realCreateBuzzClient:
    undefined as unknown as typeof import('@beeline/buzz-client').createBuzzClient,
}));

// Most tests here rely on the real createBuzzClient (talking to a stubbed
// global fetch/WS). Default the spy to delegate to it so only tests that
// explicitly override the return value change its behavior.
vi.mock('@beeline/buzz-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@beeline/buzz-client')>();
  mocks.realCreateBuzzClient = actual.createBuzzClient;
  mocks.createBuzzClient.mockImplementation(actual.createBuzzClient);
  return { ...actual, createBuzzClient: mocks.createBuzzClient };
});

import {
  AGENT_EXCHANGE_MAX_MESSAGES,
  agentTurnFailureJournalDetail,
  agentTurnFailureReply,
  agentExchangeTurnPrompt,
  abandonedCornerCloseRetryDelayMs,
  ABANDONED_CORNER_CLOSE_RETRY_BASE_MS,
  ABANDONED_CORNER_CLOSE_RETRY_CAP_MS,
  UNTRACKED_CORNER_SCAN_INTERVAL_MS,
  assertRelayCornerArchiveTarget,
  assertSubchannelArchiveTarget,
  Body,
  conciseCornerTurnSummary,
  conciseLandSummary,
  isMovedTargetLandFailure,
  cornerArchiveSummary,
  CORNER_CLOSE_TAG,
  CORNER_TARGET_SYNC_INSTRUCTION,
  CORNER_TURN_SUMMARY_INSTRUCTION,
  CORNER_TURN_SUMMARY_MAX_CHARS,
  cornerNameForIntent,
  slugifyCornerTask,
  createAgentSubchannel,
  cornerOpenTaskPrompt,
  cornerTurnPrompt,
  taskDescriptionFromCornerRequest,
  taskSlugForCornerIntent,
  isChannelAddressedMessage,
  isChannelWorkIntent,
  isReadOnlyInformationRequest,
  isRepositoryMutationRequest,
  CORNER_APPROVED_REPO_UNRESTORABLE,
  isNonRetryableRelayError,
  isTransientPermissionPollError,
  humanAgentExchangeRequest,
  ReadOnlyToolsUnavailableError,
  isAcpPromptStallError,
  ROOM_AGENT_PROMPT_TIMEOUT_MS,
  ROOM_POLL_FAILURE_BACKOFF_CAP_MS,
  RoomPollBackoff,
  type ChannelTaskRequest,
  type RoomReplyOutcome,
  codegraphMcpServer,
  readOnlyMcpServer,
  roomEditPolicyInstructions,
  roomTurnPrompt,
  roomViewConversationHistory,
  WRITE_PERMISSION_BACKSTOP_POLL_MS,
} from './body.js';
import {
  buildMergeApproval,
  buildPermissionDecision,
  buildPermissionRequest,
  defaultPermissionGrantEnvelope,
  parsePermissionDecision,
  parsePermissionRequest,
  type PermissionFreshReader,
  type PermissionRequestV1,
} from '@beeline/buzz-client';
import { AcpClient, isMutatingPermissionRequest } from './acp.js';
import { newIdentity } from '@beeline/gate';
import {
  WRITE_PERMISSION_RESPONSE_TAG,
  CHANGE_REVIEW_ARTIFACT_TAG,
  CHANGE_REVIEW_ARTIFACT_VERSION,
  CHANGE_REVIEW_EVENT_KIND,
  parseChangeReviewArtifactDescriptor,
  setAgentModelConfig,
  AGENT_PRESENCE_HEARTBEAT_MS,
  AGENT_PRESENCE_STALE_MS,
  isAgentPresenceOnline,
  KIND_AGENT_MODEL_CATALOG,
  KIND_AGENT_MODEL_CONFIG,
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_AGENT_MODEL_CATALOG,
  TAG_COMMUNITY,
  DEFAULT_AGENT_IDENTITY_NAME,
  deriveAgentDisplayName,
  fallbackAgentName,
  parseAgentCommands,
  type AgentHistoryEntry,
  type RoomViewMessage,
} from '@beeline/buzz-client';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import {
  buildAgentMessage,
  postAgentMessage,
  postAgentPresence,
  startAgentPresence,
  agentPresenceRetryDelayMs,
  AGENT_PRESENCE_RETRY_MAX_ATTEMPTS,
  stripAgentReplyPreamble,
  replyRootIdForEvent,
  STEER_QUEUED_TAG,
  SLASH_COMMAND_NOTICE_TAG,
} from './activity.js';
import {
  isBeelineAgentToolPermissionRequest,
  isReadOnlyMcpPermissionRequest,
} from './read-only-policy.js';
import { targetBranchProposalFromAgentText } from './target-branch.js';
import {
  CLAUDE_ACP_MCP_GIT_LOG_PERMISSION,
  CLAUDE_ACP_MCP_GIT_SHOW_PERMISSION,
  CLAUDE_ACP_MCP_READ_FILE_PERMISSION,
  CLAUDE_ACP_NATIVE_BASH_PERMISSION,
  CLAUDE_ACP_NATIVE_READ_TOOL_CALL,
  CLAUDE_ACP_NATIVE_WRITE_PERMISSION,
  CODEX_ACP_MCP_READ_FILE_PERMISSION,
} from './fixtures/claude-agent-acp-permissions.js';
import { ROOM_READ_ONLY_STEER } from './session-sandbox.js';
import { detectBwrapSandbox } from './bwrap-sandbox.js';
import { SessionScheduler } from './session-scheduler.js';
import { GROK_WARM_SESSION_IDLE_MS } from './harness-capabilities.js';
import { ModelSelectionUnavailableError } from './model-config.js';
import {
  agentDelegationDedupe,
  agentDelegationTags,
  type AgentDelegationEnvelope,
} from './agent-mention.js';

/**
 * Whether this host can actually build the bwrap namespace `sessionSpawnCommand`
 * targets, per the product's own start-up viability probe. A `bwrap` binary
 * that exists but cannot unshare (e.g. AppArmor-restricted unprivileged user
 * namespaces, common on CI runners) must not fail a test asserting only that
 * Body constructs the right argv — only tests that actually execute the
 * resulting command need this gate.
 */
const bwrapExecutionViable = detectBwrapSandbox().path !== undefined;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.createBuzzClient.mockReset();
  mocks.createBuzzClient.mockImplementation(mocks.realCreateBuzzClient);
});

function stubEmptyAgentHistory(body: Body): void {
  vi.spyOn(body as never, 'agentHistory' as never).mockResolvedValue([] as never);
}
describe('first-class assistant messages', () => {
  it('reduces verbose corner completions to a few short outcome bullets', () => {
    const verbose = [
      'Summary',
      '- Added a daemon-side turn summary boundary so completion messages remain easy to scan.',
      '- Updated corner message cards so consecutive agent replies have their own visual frame.',
      '- Added focused regression coverage and ran the relevant typechecks and tests.',
      '- This fourth detail should not be included in the published corner summary.',
      '',
      'Then I inspected every intermediate step and could continue narrating the implementation for several paragraphs.',
    ].join('\n');

    const summary = conciseCornerTurnSummary(verbose);

    expect(summary).toBe(
      [
        '- Added a daemon-side turn summary boundary so completion messages remain easy to scan.',
        '- Updated corner message cards so consecutive agent replies have their own visual frame.',
        '- Added focused regression coverage and ran the relevant typechecks and tests.',
      ].join('\n'),
    );
    expect(summary.length).toBeLessThanOrEqual(CORNER_TURN_SUMMARY_MAX_CHARS);
  });

  it('bounds a single run-on corner completion without cutting through a word', () => {
    const summary = conciseCornerTurnSummary(`Implemented ${'carefully '.repeat(100)}`);

    expect(summary.length).toBeLessThanOrEqual(CORNER_TURN_SUMMARY_MAX_CHARS);
    expect(summary).toMatch(/…$/);
    expect(summary).not.toMatch(/caref…$/);
    expect(CORNER_TURN_SUMMARY_INSTRUCTION).toContain('one sentence or up to three short bullets');
  });

  it('uses durable completion copy for an archived card after restart with an honest fallback', () => {
    expect(
      cornerArchiveSummary(undefined, 'Implemented the change and added regression tests.'),
    ).toBe('Implemented the change and added regression tests.');
    expect(cornerArchiveSummary('Current process summary.', 'Older durable summary.')).toBe(
      'Current process summary.',
    );
    expect(cornerArchiveSummary('   ', 'Recovered durable summary.')).toBe(
      'Recovered durable summary.',
    );
    expect(cornerArchiveSummary(undefined, undefined)).toBe(
      'Corner closed without a completed summary.',
    );
  });

  it('publishes the bounded summary instead of the full ACP corner response', async () => {
    const agent = newIdentity('concise-corner-agent-message');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/workspace',
        relayBaseUrl: 'https://relay.example',
        relayHost: 'relay.example',
        relayScheme: 'https',
        relayWsUrl: 'wss://relay.example',
        autoApprovePermissions: true,
      },
      undefined,
      agent,
    );

    await Reflect.get(body, 'publishAgentResult').call(
      body,
      'corner-id',
      { cwd: '/workspace' },
      {
        agentText: `Implemented the fix. ${'This is unnecessary process narration. '.repeat(80)}`,
        updates: [],
      },
      'Done.',
      { concise: true },
    );

    expect(published[0]!.content).toContain('Implemented the fix.');
    expect(published[0]!.content).not.toContain(
      'This is unnecessary process narration. '.repeat(4),
    );
    expect(published[0]!.content.split('\n')).toHaveLength(3);
    expect(published[0]!.content.length).toBeLessThanOrEqual(CORNER_TURN_SUMMARY_MAX_CHARS);
  });

  it('publishes a corner turn final as exactly one durable agent message', async () => {
    const agent = newIdentity('coalesced-corner-agent');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/workspace',
        relayBaseUrl: 'https://relay.example',
        relayHost: 'relay.example',
        relayScheme: 'https',
        relayWsUrl: 'wss://relay.example',
        autoApprovePermissions: true,
      },
      undefined,
      agent,
    );

    const agentText = "I'll take a look at the README first.\n\nAdded the note and ran the tests.";
    const summary = await Reflect.get(body, 'publishAgentResult').call(
      body,
      'corner-id',
      { cwd: '/workspace' },
      { agentText, updates: [] },
      'Done.',
      { concise: true },
    );

    expect(summary).toContain("I'll take a look at the README first.");
    expect(published).toHaveLength(1);
    expect(published[0]!.kind).toBe(9);
    expect(published[0]!.tags).toContainEqual(['t', 'agent-message']);
  });

  it('all corner turn call sites funnel through the one-final-message merge gate', () => {
    const source = readFileSync(new URL('./body.ts', import.meta.url), 'utf8');
    const gateCallSites = source.match(/this\.finishCornerTurnAgainstMergeGate\(/g) ?? [];
    expect(source).not.toContain('summaryOnly');
    expect(source).not.toContain('createNarrativeCommitter');
    expect(gateCallSites).toHaveLength(2);
  });

  it('the corner merge-gate instruction carries the external-gate failure-honesty rule at every turn call site', () => {
    // Live reproduction (corner "Fix-corner-open-to-use-model-summary", Ox,
    // 2026-08-23): an external gate that could not initialize left the review
    // panel empty while the agent told the human to approve. The one shared
    // instruction must say what to do instead, and every corner turn call site
    // (opening turn + follow-ups + the conclude nudge) must carry it — a claim
    // of readiness with no published review target sends the human's approval
    // nowhere.
    const source = readFileSync(new URL('./body.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /fails to initialize or run[^']*quote its exact error[^']*never ask for approval/,
    );
    // Declaration plus exactly the three corner turn prompts.
    expect(source.match(/CORNER_MERGE_GATE_INSTRUCTION/g)).toHaveLength(3);
  });

  it('reserves target synchronization for one merge-press follow-up turn', () => {
    const source = readFileSync(new URL('./body.ts', import.meta.url), 'utf8');
    expect(CORNER_TARGET_SYNC_INSTRUCTION).toMatch(/one explicit automatic follow-up/i);
    expect(CORNER_TARGET_SYNC_INSTRUCTION).toMatch(/you own all branch-content work/i);
    expect(source).toMatch(
      /moved to \$\{targetTip\}[^`]*bring this branch up to date and make it land, whatever it takes/i,
    );
    expect(source).not.toMatch(/silent:\s*true[\s\S]{0,800}target-sync/i);
    // Declaration, new/restored system prompts, opening/follow-up turns, and
    // the conclude watch's nudge. The actual sync prompt is emitted only after
    // a signed merge press fails its first ff-only landing attempt.
    expect(source.match(/CORNER_TARGET_SYNC_INSTRUCTION/g)).toHaveLength(5);
  });

  it('strips only a leading Codex skill-budget warning', () => {
    const warning =
      'Warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill by reading its SKILL.md.';
    expect(stripAgentReplyPreamble(`\n${warning}\n\nThe real answer.`)).toBe('The real answer.');
    expect(stripAgentReplyPreamble(`The real answer.\n\n${warning}`)).toBe(
      `The real answer.\n\n${warning}`,
    );
    expect(stripAgentReplyPreamble('Warning: This API is deprecated.\nUse v2.')).toBe(
      'Warning: This API is deprecated.\nUse v2.',
    );
    expect(
      stripAgentReplyPreamble(
        'Warning: Skill descriptions were shortened to fit the skills context budget.\nCodex can still see every skill by reading its SKILL.md.\n\nClean reply.',
      ),
    ).toBe('Clean reply.');
    expect(
      stripAgentReplyPreamble(
        'Notice: Plugin descriptions were shortened because of the context budget limit.\n\nVisible answer.',
      ),
    ).toBe('Visible answer.');
  });

  it('strips a full pi-acp cold-session startup banner, including the update-nag line', () => {
    const banner = [
      'pi v0.83.0',
      '---',
      '',
      '## Context',
      '- /home/lunchbox/proj-buzzy/AGENTS.md',
      '',
      '## Skills',
      '- /home/lunchbox/.pi/agent/skills/trusty-squire/SKILL.md',
      '- /home/lunchbox/.pi/agent/skills/no-mistakes/SKILL.md',
      '- /home/lunchbox/.pi/agent/skills/find-skills/SKILL.md',
      '- /home/lunchbox/.pi/agent/skills/create-payment-credential/SKILL.md',
      '',
      '---',
      'New version available: v0.84.2 (installed v0.83.0). Run: `npm i -g @earendil-works/pi-coding-agent`',
      '',
    ].join('\n');
    expect(stripAgentReplyPreamble(banner)).toBe('');
    expect(stripAgentReplyPreamble(`${banner}\nThe real answer.`)).toBe('The real answer.');
  });

  it.each([
    ['a Room reply', { replyTo: 'trigger-event' }],
    ['a corner turn summary', { concise: true }],
  ] as const)(
    'never publishes a cold session harness banner as %s — falls back instead',
    async (_label, options) => {
      const agent = newIdentity('banner-fallback-agent');
      const published: NostrEvent[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return new Response(JSON.stringify({ accepted: true }), { status: 200 });
        }),
      );
      const body = new Body(
        {
          agentBinary: '/nonexistent',
          mcpBinary: '/nonexistent',
          agentEnv: {},
          workspaceRoot: '/workspace',
          relayBaseUrl: 'https://relay.example',
          relayHost: 'relay.example',
          relayScheme: 'https',
          relayWsUrl: 'wss://relay.example',
          autoApprovePermissions: true,
        },
        undefined,
        agent,
      );

      const banner = [
        'pi v0.83.0',
        '---',
        '',
        '## Skills',
        '- /home/lunchbox/.pi/agent/skills/trusty-squire/SKILL.md',
        '',
        '---',
        'New version available: v0.84.2 (installed v0.83.0). Run: `npm i -g @earendil-works/pi-coding-agent`',
        '',
      ].join('\n');

      await Reflect.get(body, 'publishAgentResult').call(
        body,
        'channel-id',
        { cwd: '/workspace' },
        { agentText: banner, updates: [] },
        "I couldn't produce a response to that message; please try again.",
        options,
      );

      expect(published).toHaveLength(1);
      expect(published[0]!.content).toBe(
        "I couldn't produce a response to that message; please try again.",
      );
      expect(published[0]!.content).not.toContain('pi v0.83.0');
      expect(published[0]!.content).not.toContain('New version available');
    },
  );

  it('omits cross-channel reply linkage for corner outcomes', async () => {
    const agent = newIdentity('corner-agent-message');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await postAgentMessage('child-corner', agent, 'Completed the requested work.');

    expect(published[0]!.tags).toContainEqual(['h', 'child-corner']);
    expect(published[0]!.tags.some((tag) => tag[0] === 'e')).toBe(false);
  });

  it('preserves the original NIP-10 root for nested Room replies', () => {
    const agent = newIdentity('threaded-agent-message');
    const incoming = signEvent(
      {
        pubkey: agent.publicKey,
        created_at: 1,
        kind: 9,
        tags: [
          ['h', 'room-id'],
          ['e', 'root-message', '', 'root'],
          ['e', 'member-reply', '', 'reply'],
        ],
        content: 'Nested question',
      },
      agent.secretKey,
    );
    const reply = buildAgentMessage(
      'room-id',
      agent,
      'Nested answer',
      incoming.id,
      [],
      [],
      replyRootIdForEvent(incoming),
    );

    expect(reply.tags).toContainEqual(['e', 'root-message', '', 'root']);
    expect(reply.tags).toContainEqual(['e', incoming.id, '', 'reply']);
  });

  it('publishes agent outputs as the shared link-only attachment format', async () => {
    const agent = newIdentity('agent-file-message');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await postAgentMessage('room-id', agent, 'Here it is.', undefined, [
      {
        url: 'https://relay.example/media/mushroom.png',
        thumbnailUrl: 'https://relay.example/media/mushroom-thumb.jpg',
        name: 'mushroom.png',
        mimeType: 'image/png',
        size: 12_000_000,
      },
    ]);

    const serialized = JSON.stringify(published[0]);
    expect(published[0]!.content).toBe('Here it is.');
    expect(published[0]!.tags).toContainEqual(['t', 'buzz-attachment']);
    expect(serialized).toContain('https://relay.example/media/mushroom.png');
    expect(serialized).not.toContain('base64');
    expect(serialized.length).toBeLessThan(2_000);
  });

  it('uploads an agent worktree file before publishing only its link metadata', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'buzzy-agent-output-'));
    const fileBytes = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="8" /></svg>';
    await writeFile(join(workspace, 'mushroom.svg'), fileBytes);
    const agent = newIdentity('agent-output-upload');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/upload')) {
          const hash = new Headers(init?.headers).get('X-SHA-256');
          return new Response(
            JSON.stringify({
              url: 'https://relay.example/media/mushroom.svg',
              sha256: hash,
              size: new TextEncoder().encode(fileBytes).byteLength,
              type: 'image/svg+xml',
              thumb: 'https://relay.example/media/mushroom-thumb.jpg',
            }),
            { status: 200 },
          );
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: workspace,
        relayBaseUrl: 'https://relay.example',
        relayHost: 'relay.example',
        relayScheme: 'https',
        relayWsUrl: 'wss://relay.example',
        autoApprovePermissions: true,
      },
      undefined,
      agent,
    );

    try {
      await Reflect.get(body, 'publishAgentResult').call(
        body,
        'room-id',
        { cwd: workspace },
        {
          agentText: 'Here it is. [[buzz-attachment:mushroom.svg]]',
          updates: [],
        },
        'Done.',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }

    const serialized = JSON.stringify(published[0]);
    expect(published[0]!.content).toBe('Here it is.');
    expect(serialized).toContain('https://relay.example/media/mushroom.svg');
    expect(serialized).toContain('https://relay.example/media/mushroom-thumb.jpg');
    expect(serialized).not.toContain(fileBytes);
    expect(serialized).not.toContain('base64');
  });

  it('uploads an allowlisted Room workbench file, publishes its isolated preview URL, and refuses a disallowed type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buzzy-room-workbench-output-'));
    const repository = join(root, 'repository');
    const workbench = join(root, 'agent-private', 'workbench');
    mkdirSync(repository, { recursive: true });
    mkdirSync(workbench, { recursive: true });
    const htmlPath = join(workbench, 'report.html');
    const executablePath = join(workbench, 'payload.exe');
    await writeFile(htmlPath, '<!doctype html><title>Workbench report</title>');
    await writeFile(executablePath, 'not allowed');
    const agent = newIdentity('agent-workbench-upload');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe('https://usebeeline.app/upload');
        const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
        const hash = new Headers(init?.headers).get('X-SHA-256');
        return new Response(
          JSON.stringify({
            url: 'https://usebeeline.app/media/hash/report.html',
            sha256: hash,
            size: bytes.byteLength,
            type: new Headers(init?.headers).get('Content-Type'),
          }),
          { status: 200 },
        );
      }),
    );
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: repository,
        relayBaseUrl: 'https://usebeeline.app',
        relayHost: 'usebeeline.app',
        relayScheme: 'https',
        relayWsUrl: 'wss://usebeeline.app',
        autoApprovePermissions: true,
      },
      undefined,
      agent,
    );

    try {
      const result = await Reflect.get(body, 'uploadAgentOutputs').call(
        body,
        { cwd: repository, workbench: { dir: workbench, storageDir: workbench } },
        {
          agentText:
            `Ready. [[buzz-attachment:${htmlPath}]] ` + `[[buzz-attachment:${executablePath}]]`,
          updates: [],
        },
      );
      expect(result.attachments).toEqual([
        expect.objectContaining({
          url: 'https://usebeeline.app/media/hash/report.html',
          previewUrl: 'https://preview.usebeeline.app/media/hash/report.html',
          name: 'report.html',
          mimeType: 'text/html',
        }),
      ]);
      expect(result.failed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('captures a workbench artifact before the producing session is recycled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buzzy-workbench-recycle-'));
    const repository = join(root, 'repository');
    const logicalWorkbench = join(root, 'agent-private', 'workbench');
    const liveWorkbench = join(root, 'proc', '2952774', 'root', 'workbench');
    const logicalArtifact = join(logicalWorkbench, 'operation-taco-fund-playbook.html');
    const liveArtifact = join(liveWorkbench, 'operation-taco-fund-playbook.html');
    const html = '<!doctype html><title>Operation Taco Fund</title>';
    await mkdir(repository, { recursive: true });
    await mkdir(liveWorkbench, { recursive: true });
    const scheduler = new SessionScheduler({ maxLiveSessions: 1, idleMs: 60_000 });
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/upload')) {
          expect(new TextDecoder().decode(await new Response(init?.body).arrayBuffer())).toBe(html);
          return new Response(
            JSON.stringify({
              url: 'https://usebeeline.app/media/hash/operation-taco-fund-playbook.html',
              sha256: new Headers(init?.headers).get('X-SHA-256'),
              size: new TextEncoder().encode(html).byteLength,
              type: 'text/html',
            }),
            { status: 200 },
          );
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: repository,
        relayBaseUrl: 'https://usebeeline.app',
        relayHost: 'usebeeline.app',
        relayScheme: 'https',
        relayWsUrl: 'wss://usebeeline.app',
        autoApprovePermissions: true,
      },
      undefined,
      newIdentity('workbench-recycle-agent'),
      undefined,
      { scheduler },
    );
    vi.spyOn(Reflect.get(body, 'durableState'), 'recordModelTurn').mockResolvedValue(undefined);
    const suspend = vi.fn(async () => {
      await rm(liveWorkbench, { recursive: true, force: true });
    });
    const session = {
      channelId: 'workbench-recycle-room',
      sessionId: 'physical-2952774',
      logicalSessionId: 'logical-workbench-recycle',
      cwd: repository,
      mode: 'readonly' as const,
      workbench: { dir: logicalWorkbench, storageDir: liveWorkbench },
      client: {
        sessionPrompt: vi.fn(async () => {
          await writeFile(liveArtifact, html);
          return {
            stopReason: 'end_turn',
            updates: [],
            agentText: `Here is the playbook. [[buzz-attachment:${logicalArtifact}]]`,
            toolCalls: [],
          };
        }),
        sessionCancel: vi.fn(),
      },
      lifecycle: {
        activate: vi.fn().mockResolvedValue('physical-2952774'),
        suspend,
      },
    } as never;

    try {
      const result = await Reflect.get(body, 'promptAgent').call(
        body,
        session,
        'Make the playbook.',
        {
          channelId: 'workbench-recycle-room',
          requestId: 'workbench-recycle-request',
          originalRequestId: 'workbench-recycle-request',
          cause: 'room-message',
          silent: true,
        },
      );

      // Reproduce the reported lifecycle gap: the physical sandbox and its
      // tmpfs disappear after ACP returns but before delivery starts. A new
      // session claiming the single process slot forces the same LRU recycle
      // that made the production /proc keeper path go stale.
      await scheduler.run(
        'replacement-room',
        {
          activate: vi.fn().mockResolvedValue('replacement-physical'),
          suspend: vi.fn().mockResolvedValue(undefined),
        },
        async () => undefined,
      );
      expect(suspend).toHaveBeenCalledOnce();
      await expect(stat(liveArtifact)).rejects.toMatchObject({ code: 'ENOENT' });

      await Reflect.get(body, 'publishAgentResult').call(
        body,
        'workbench-recycle-room',
        session,
        result,
        'Done.',
      );

      expect(published).toHaveLength(1);
      expect(published[0]!.content).toBe('Here is the playbook.');
      expect(JSON.stringify(published[0])).toContain(
        'https://preview.usebeeline.app/media/hash/operation-taco-fund-playbook.html',
      );
    } finally {
      await scheduler.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes plain attachment failure copy without filesystem plumbing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buzzy-workbench-safe-copy-'));
    const repository = join(root, 'repository');
    const logicalWorkbench = join(root, 'agent-private', 'workbench');
    const deadStorage =
      '/proc/2952774/root/home/lunchbox/.local/state/beeline/agents/agent/rooms/room/agent-private/workbench';
    await mkdir(repository, { recursive: true });
    const published: NostrEvent[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: repository,
        relayBaseUrl: 'https://relay.example',
        relayHost: 'relay.example',
        relayScheme: 'https',
        relayWsUrl: 'wss://relay.example',
        autoApprovePermissions: true,
      },
      undefined,
      newIdentity('workbench-safe-copy-agent'),
    );

    try {
      await Reflect.get(body, 'publishAgentResult').call(
        body,
        'room-id',
        {
          cwd: repository,
          workbench: { dir: logicalWorkbench, storageDir: deadStorage },
        },
        {
          agentText:
            `I finished the report. ` +
            `[[buzz-attachment:${join(logicalWorkbench, 'missing-report.html')}]]`,
          updates: [],
        },
        'Done.',
      );

      expect(published).toHaveLength(1);
      expect(published[0]!.content).toBe(
        "I finished the report.\n\nI made a file to show you but couldn't deliver it. I'll regenerate it.",
      );
      expect(published[0]!.content).not.toMatch(/ENOENT|\/proc\/|realpath|Attachment unavailable/);
      expect(published[0]!.content).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('corner display names', () => {
  it('turns the human request into a three-word verb-first corner name', () => {
    expect(cornerNameForIntent('Fix OAuth callback + retry state', 'room-id')).toBe(
      'Fix OAuth Callback',
    );
  });

  it('uses a grammatical fallback when no task is available', () => {
    expect(cornerNameForIntent('  ', '12345678-abcd')).toBe('Implement Corner Work');
  });

  it('derives the name from the actual task, not the "open a corner" verb that opened it', () => {
    expect(cornerNameForIntent('open a corner and add color to code blocks', 'room-id')).toBe(
      'Add Color Code',
    );
    expect(cornerNameForIntent('open the corner and add color to code blocks', 'room-id')).toBe(
      'Add Color Code',
    );
    expect(cornerNameForIntent('please open a new corner to fix the flaky test', 'room-id')).toBe(
      'Fix The Flaky',
    );
  });

  it('strips a trailing "...in a new corner" mention just as well as a leading one', () => {
    expect(
      cornerNameForIntent('start working on syntax highlighting in a new corner', 'room-id'),
    ).toBe('Implement Syntax Highlighting');
  });

  it('uses the grammatical fallback when the request is only the imperative itself', () => {
    expect(cornerNameForIntent('open a corner', 'room-id')).toBe('Implement Corner Work');
    expect(cornerNameForIntent('open up a new corner', 'room-id')).toBe('Implement Corner Work');
  });

  it('leaves a message with no corner-open imperative untouched (the agent-originated write-request flow)', () => {
    expect(cornerNameForIntent('add color to code blocks', 'room-id')).toBe('Add Color Code');
  });

  it('names the task even when the request opens with an @mention or conversational scaffolding', () => {
    const cases: [string, string][] = [
      // The dogfooded regression: the mention plus the imperative ate the name.
      ['@lena open a corner and add a haiku to README.md', 'Add Haiku README.md'],
      ['@lena go fix the login bug', 'Fix The Login'],
      ['@lena, please open a corner and fix the flaky test', 'Fix The Flaky'],
      ['@lena make a corner for the sidebar redesign', 'Implement The Sidebar'],
      ['@lena spin up a corner and refactor the parser', 'Refactor The Parser'],
      ['hey @lena, can you open a new corner to update the changelog', 'Update The Changelog'],
      ["@lena let's add dark mode to settings", 'Add Dark Mode'],
      [
        '@lena start working on syntax highlighting in a new corner',
        'Implement Syntax Highlighting',
      ],
    ];
    for (const [request, slug] of cases) {
      expect([request, cornerNameForIntent(request, 'room-id')]).toEqual([request, slug]);
    }
  });

  it('falls back to the generic corner name when the request names no work at all', () => {
    expect(cornerNameForIntent('@lena go', 'room-id')).toBe('Implement Corner Work');
    expect(cornerNameForIntent('@lena open a corner', 'room-id')).toBe('Implement Corner Work');
    expect(cornerNameForIntent('@lena ok do it', 'room-id')).toBe('Implement Corner Work');
  });

  it('taskSlugForCornerIntent is the same task-descriptive basis openSubchannel uses for both the corner name and the feature branch', () => {
    // The display name and branch slug share one formatted semantic stem.
    const intent = 'open a corner and add color to code blocks';
    expect(taskSlugForCornerIntent(intent)).toBe('add-color-code');
    expect(slugifyCornerTask(cornerNameForIntent(intent, 'room-id'))).toBe(
      taskSlugForCornerIntent(intent),
    );
    expect(taskSlugForCornerIntent('open a corner')).toBe('');
  });

  it('taskDescriptionFromCornerRequest strips only the corner-open imperative, keeping the rest of the sentence intact', () => {
    expect(taskDescriptionFromCornerRequest('open a corner and add color to code blocks')).toBe(
      'add color to code blocks',
    );
    expect(taskDescriptionFromCornerRequest('Fix OAuth callback + retry state')).toBe(
      'Fix OAuth callback + retry state',
    );
  });
});

describe('live steering loop', () => {
  it.skip('polls member messages while the original agent task is still running', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-body-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const session = {
      channelId: 'subchannel',
      sessionId: 'session',
      client,
      mode: 'edit' as const,
      parentChannelId: 'room',
      archived: false,
    };
    body.registerSubchannel({
      subchannelId: 'subchannel',
      worktreePath: '/tmp/worktree',
      featureBranch: 'feature/steer',
      role: body.agent,
      session,
      lastPolledAt: 0,
      archived: false,
    });

    const runningTasks = Reflect.get(body, 'runningAgentTasks') as Map<string, Promise<void>>;
    runningTasks.set('subchannel', new Promise(() => undefined));

    const abort = new AbortController();
    let memberPolls = 0;
    body.assertRepositorySafety = async () => undefined;
    body.provision = async () => session;
    body.pollChannelRequests = async () => 0;
    body.pollMergeCompletions = async () => 0;
    body.pollMembers = async () => {
      memberPolls++;
      abort.abort();
      return 1;
    };

    await body.runChannelLoop(
      'room',
      { repo: 'repo', localPath: '/tmp/repo' },
      { pollMs: 1, signal: abort.signal },
    );

    expect(memberPolls).toBe(1);
  });
});

describe('corner narrative persistence', () => {
  function newBody(agent: ReturnType<typeof newIdentity>, workspaceRoot = '/workspace') {
    return new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot,
        relayBaseUrl: 'https://relay.example',
        relayHost: 'relay.example',
        relayScheme: 'https',
        relayWsUrl: 'wss://relay.example',
        autoApprovePermissions: true,
      },
      undefined,
      agent,
    );
  }

  function stubPublishing(): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  function agentMessages(published: NostrEvent[]): NostrEvent[] {
    return published.filter(
      (event) =>
        event.kind === 9 && event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-message'),
    );
  }

  /** Fake ACP client that streams `agent_message_chunk`-style deltas like a real corner turn. */
  function fakeMultiParagraphSessionPrompt(
    paragraphs: readonly string[],
    options: { duplicateEach?: boolean; finalOnly?: boolean } = {},
  ) {
    return vi.fn(
      async (
        _sessionId: string,
        _prompt: string,
        _timeoutMs: number,
        onChunk?: (delta: string, fullText: string) => void,
      ) => {
        let text = '';
        for (const paragraph of paragraphs) {
          const delta = text ? `\n\n${paragraph}` : paragraph;
          text += delta;
          onChunk?.(delta, text);
          if (options.duplicateEach) onChunk?.(delta, text);
        }
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: options.finalOnly ? (paragraphs.at(-1) ?? '') : text,
          toolCalls: [],
        };
      },
    );
  }

  it('coalesces three Goose-style progress messages into a retracted draft and one final chat message', async () => {
    const published = stubPublishing();
    const body = newBody(newIdentity('goose-streaming-agent'));
    const sessionPrompt = fakeMultiParagraphSessionPrompt(
      [
        'Looked at the failing test and reproduced it locally.',
        'Found the root cause in the retry loop and pushed a fix.',
        'Ran the suite again; all green.',
        'Fixed the publisher and all tests pass.',
      ],
      { duplicateEach: true, finalOnly: true },
    );
    const session = {
      channelId: 'corner-1',
      sessionId: 'session-1',
      client: { sessionPrompt, sessionCancel: vi.fn() },
    } as never;

    const result = await Reflect.get(body, 'promptAgent').call(body, session, 'do the work', {
      channelId: 'corner-1',
      requestId: 'req-1',
      originalRequestId: 'req-1',
      cause: 'corner-follow-up',
    });
    await Reflect.get(body, 'publishAgentResult').call(body, 'corner-1', session, result, 'Done.');

    const messages = agentMessages(published);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe(result.agentText);
    expect(messages[0]!.tags).toContainEqual(['h', 'corner-1']);

    const drafts = published.filter((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-draft'),
    );
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts.at(-1)!.content).toBe('');
    expect(drafts.at(-1)!.tags).toContainEqual(['status', 'closed']);
    expect(drafts.slice(0, -1).every((event) => event.kind !== 9)).toBe(true);
  });

  it('publishes a Grok message chunk as a live draft before the ACP turn completes', async () => {
    const published = stubPublishing();
    const body = new Body(
      {
        agentBinary: '/usr/local/bin/grok',
        agentCommand: '/usr/local/bin/grok',
        agentArgs: ['agent', 'stdio'],
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: '/workspace',
        relayBaseUrl: 'https://relay.example',
        relayHost: 'relay.example',
        relayScheme: 'https',
        relayWsUrl: 'wss://relay.example',
        autoApprovePermissions: true,
      },
      undefined,
      newIdentity('grok-streaming-agent'),
    );
    let releaseTurn!: () => void;
    const held = new Promise<void>((resolveHeld) => {
      releaseTurn = resolveHeld;
    });
    const sessionPrompt = vi.fn(
      async (
        _sessionId: string,
        _prompt: string,
        _timeoutMs: number,
        onChunk?: (delta: string, fullText: string) => void,
      ) => {
        onChunk?.('I found the ', 'I found the ');
        await held;
        onChunk?.('answer.', 'I found the answer.');
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: 'I found the answer.',
          toolCalls: [],
        };
      },
    );
    const session = {
      channelId: 'grok-room',
      sessionId: 'grok-session',
      client: { sessionPrompt, sessionCancel: vi.fn() },
    } as never;

    let completed = false;
    const turn = Reflect.get(body, 'promptAgent')
      .call(body, session, 'inspect this', {
        channelId: 'grok-room',
        requestId: 'grok-request',
        originalRequestId: 'grok-request',
        cause: 'room-message',
      })
      .then(() => {
        completed = true;
      });

    await vi.waitFor(
      () =>
        expect(
          published.some((event) =>
            event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-draft'),
          ),
        ).toBe(true),
      { timeout: 1_500 },
    );
    expect(completed).toBe(false);
    releaseTurn();
    await turn;
  });

  it('falls back to the caller-provided summary instead of throwing when concise reduction empties an otherwise real reply', async () => {
    const published = stubPublishing();
    const body = newBody(newIdentity('empty-concise-agent'));

    const reply = await Reflect.get(body, 'publishAgentResult').call(
      body,
      'corner-empty',
      { cwd: '/workspace' },
      {
        agentText: '```\nconsole.log("fixed");\n```',
        updates: [],
      },
      'Completed the requested follow-up.',
      { concise: true },
    );

    expect(reply).toBe('Completed the requested follow-up.');
    expect(published).toHaveLength(1);
    expect(published[0]!.content).toBe('Completed the requested follow-up.');
  });

  it('conciseCornerTurnSummary alone empties a code-block-only reply (root cause of the throw this fixes)', () => {
    expect(conciseCornerTurnSummary('```\nconsole.log("fixed");\n```')).toBe('');
  });

  it('delivers every untagged solo-human turn but suppresses identical consecutive replies', async () => {
    const published = stubPublishing();
    const agent = newIdentity('steer-narration-agent');
    const human = newIdentity('steer-human');
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'buzzy-corner-narrative-'));
    try {
      const body = newBody(agent, workspaceRoot);
      stubEmptyAgentHistory(body);
      const sessionPrompt = fakeMultiParagraphSessionPrompt([
        'Applied the requested follow-up tweak.',
        'Ran the suite again; still green.',
      ]);
      const startPlan = vi.fn(async () => undefined);
      const session = {
        channelId: 'corner-steer',
        parentChannelId: 'room-steer',
        sessionId: 'session-steer',
        client: { sessionPrompt, sessionCancel: vi.fn(), activeRunId: () => undefined },
        activityProjection: { startPlan, completePlan: vi.fn(async () => undefined) },
      } as never;

      body.registerSubchannel({
        subchannelId: 'corner-steer',
        worktreePath: '/tmp/nonexistent-corner-steer',
        featureBranch: 'feature/steer',
        role: agent,
        session,
        lastPolledAt: 0,
        archived: false,
        taskDescription: 'Publish the mockup through a Cloudflare tunnel.',
      });

      const followUps = ['One more tweak please.', '@codex u alive?', 'Keep going.'].map(
        (content, index) =>
          signEvent(
            {
              pubkey: human.publicKey,
              created_at: Math.floor(Date.now() / 1000) + index,
              kind: 9,
              tags: [['h', 'corner-steer']],
              content,
            },
            human.secretKey,
          ),
      );
      (Reflect.get(body, 'agentRelay') as { queryEvents: unknown }).queryEvents = vi
        .fn()
        .mockResolvedValue(followUps);

      const count = await body.pollMembers('corner-steer');

      expect(count).toBe(3);
      expect(sessionPrompt).toHaveBeenCalledTimes(3);
      expect(startPlan.mock.calls.map(([objective]) => objective)).toEqual([
        'Publish the mockup through a Cloudflare tunnel.',
        'Publish the mockup through a Cloudflare tunnel.',
        'Publish the mockup through a Cloudflare tunnel.',
      ]);
      const messages = agentMessages(published);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toContain('Applied the requested follow-up tweak.');
      expect(messages[0]!.content).toContain('Ran the suite again; still green.');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
