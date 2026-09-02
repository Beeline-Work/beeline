import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { AcpClient, isMutatingPermissionRequest, type McpServerWire } from './acp.js';
import { harnessStateDirsFromEnv, prepareRoomAgentHome } from './agent-home.js';
import { isSenderPermitted, LEGACY_ACCESS_POLICY } from './access-policy.js';
import { stripAgentReplyPreamble } from './reply-sanitizer.js';
import { readOnlyMcpServer } from './room-session.js';
import { credentialMaskPaths, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  agentArgsWithModelSelection,
  applyAgentModelSelection,
  filterAllowedModelConfigOptions,
  parseAdvertisedConfigOptions,
} from './model-config.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeIdentity } from './runtime.js';
import { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';

type WorkspaceRoster = DaemonOperationMap['getWorkspaceRoster']['output'];

export interface MonolithRoomTurnHealth {
  poll(): void;
  failure(retryInMs: number): void;
  presence(status: 'online' | 'offline'): void;
}

export interface MonolithRoomTurnOptions {
  roomId: string;
  workspaceId: string;
  cwd: string;
  runtime: AgentRuntimeRecord;
  config: BodyConfig;
  api: DaemonApiClient;
  scheduler: SessionScheduler;
  health: MonolithRoomTurnHealth;
  signal?: AbortSignal;
  pollMs?: number;
  createAcpClient?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
}

/**
 * Monolith-only Room turn leaf.
 *
 * This module deliberately has no relay client, relay URL, Nostr event, or
 * BuzzClient dependency. The transport cutover is therefore structural: a
 * monolith Room cannot accidentally fall through to a retired relay call.
 */
export class MonolithRoomTurnLoop {
  private readonly agent: ReturnType<typeof runtimeIdentity>;
  private client?: AcpClient;
  private sessionId?: string;
  private busy = false;
  private forcedStop = false;
  private draftTail = Promise.resolve();

  constructor(private readonly options: MonolithRoomTurnOptions) {
    this.agent = runtimeIdentity(options.runtime.agent);
  }

  isBusy(): boolean {
    return this.busy;
  }

  currentPrincipalCanDrive(_workspaceId: string, principalId: string): Promise<boolean> {
    return Promise.resolve(
      isSenderPermitted(
        this.options.config.accessPolicy ?? LEGACY_ACCESS_POLICY,
        principalId,
        this.options.config.accessOwnerPubkey,
        this.options.config.accessAllowlist,
      ),
    );
  }

  async refreshPersonaForSoulUpdate(): Promise<void> {
    await this.options.scheduler.suspend(this.options.roomId);
  }

  async prepareForForcedUpdateRestart(): Promise<void> {
    this.forcedStop = true;
  }

  async forceRecoverRoom(): Promise<void> {
    if (this.client && this.sessionId) this.client.sessionCancel(this.sessionId);
    await this.options.scheduler.forceSuspend(this.options.roomId);
  }

  private roster(): Promise<WorkspaceRoster> {
    return this.options.api.execute('getWorkspaceRoster', {
      agentId: this.agent.publicKey,
      workspaceId: this.options.workspaceId,
    });
  }

  private async activate(): Promise<string> {
    if (this.client?.isAlive && this.sessionId) return this.sessionId;
    const [configuration, roster] = await Promise.all([
      this.options.api.execute('getAgentConfiguration', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
      }),
      this.roster(),
    ]);
    await mkdir(this.options.cwd, { recursive: true });
    const homeOverlay = this.options.config.agentHomeRoot
      ? await prepareRoomAgentHome({
          root: this.options.config.agentHomeRoot,
          sharedSkills: this.options.config.sharedSkills ?? [],
          ...(this.options.config.operatorHome
            ? { operatorHome: this.options.config.operatorHome }
            : {}),
        })
      : {};
    const command = this.options.config.agentCommand ?? this.options.config.agentBinary;
    const selection =
      configuration.model || configuration.effort
        ? { model: configuration.model, effort: configuration.effort }
        : this.options.config.modelSelection;
    const agentEnv = { ...this.options.config.agentEnv, ...homeOverlay };
    const agentArgs = agentArgsWithModelSelection(
      {
        kind: this.options.config.agentKind,
        command,
        args: this.options.config.agentArgs ?? [],
      },
      selection,
    );
    const operatorHome = this.options.config.operatorHome ?? homedir();
    const { stateDirs, tmpDir } = harnessStateDirsFromEnv(agentEnv);
    const homeStateDirs = harnessHomeStateDirs(command, agentEnv.HOME ?? operatorHome);
    await Promise.all(homeStateDirs.map((dir) => mkdir(dir, { recursive: true })));
    const spawnCommand = wrapAgentCommand({
      bwrapPath: this.options.config.bwrapPath,
      spec: {
        mode: 'readonly',
        cwd: this.options.cwd,
        harnessStateDirs: stateDirs,
        harnessHomeStateDirs: homeStateDirs,
        ...(tmpDir ? { tmpDir } : {}),
        maskPaths: credentialMaskPaths(this.options.config.sandboxMaskPaths, operatorHome),
      },
      command,
      args: agentArgs,
    });
    const clientOptions: ConstructorParameters<typeof AcpClient>[0] = {
      agentCommand: spawnCommand.command,
      agentArgs: spawnCommand.args,
      agentEnv,
      agentCwd: this.options.cwd,
      agentLabel: command,
      autoApprovePermissions: false,
      permissionHandler: (request) =>
        Promise.resolve(isMutatingPermissionRequest(request) ? 'reject' : 'allow'),
    };
    this.client = (this.options.createAcpClient ?? ((value) => new AcpClient(value)))(
      clientOptions,
    );
    await this.client.start();
    const servers: McpServerWire[] = [readOnlyMcpServer(this.options.config, this.options.cwd)];
    const self = roster.members.find((member) => member.identityId === this.agent.publicKey);
    const persona = self?.soul;
    const opened = await this.client.sessionNew({
      cwd: this.options.cwd,
      mcpServers: servers,
      mode: 'readonly',
      systemPrompt: [
        `Your Beeline Room identity is ${self?.name ?? this.agent.name}.`,
        persona?.instructions
          ? `Human-authored Workspace persona: ${persona.name}. ${persona.instructions}`
          : '',
        'You are answering inside a read-only Room. Use only the mounted read-only tools.',
        'Never claim an action or reply happened unless the prompt or a tool result proves it.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    this.sessionId = opened.sessionId;
    if (selection) {
      const options = filterAllowedModelConfigOptions(
        parseAdvertisedConfigOptions(opened.raw, selection.model),
      );
      await applyAgentModelSelection(this.client, opened.sessionId, options, selection);
    }
    return opened.sessionId;
  }

  private lifecycle(): SessionLifecycle {
    return {
      activate: () => this.activate(),
      suspend: async () => {
        const client = this.client;
        this.client = undefined;
        this.sessionId = undefined;
        if (client?.isAlive) await client.stop();
      },
    };
  }

  private async prompt(item: {
    id: string;
    authorId: string;
    body: string;
    createdAt: number;
  }): Promise<void> {
    const api = this.options.api;
    await api.execute('postAgentTurnReceipt', {
      agentId: this.agent.publicKey,
      roomId: this.options.roomId,
      requestId: item.id,
      status: 'working',
      generationId: `${this.agent.publicKey}:${this.options.roomId}`,
    });
    await api.execute('postAgentActivity', {
      agentId: this.agent.publicKey,
      roomId: this.options.roomId,
      requestId: item.id,
      activity: [{ kind: 'thinking', title: 'Working', status: 'in_progress' }],
    });
    try {
      await this.options.scheduler.run(
        this.options.roomId,
        this.lifecycle(),
        async () => {
          if (this.forcedStop) throw new Error('monolith Room turn stopped for daemon handoff');
          this.busy = true;
          const [conversation, roster] = await Promise.all([
            api.execute('getRoomConversation', { roomId: this.options.roomId, limit: 200 }),
            this.roster(),
          ]);
          const names = new Map(roster.members.map((member) => [member.identityId, member.name]));
          const transcript = conversation.items
            .filter((message) => message.type === 'message' && message.id !== item.id)
            .slice(-80)
            .map(
              (message) =>
                `${names.get(message.authorId) ?? message.authorId.slice(0, 12)}: ${message.body}`,
            )
            .join('\n');
          const prompt = [
            transcript ? `Room conversation so far:\n${transcript}` : '',
            `Newest human message from ${names.get(item.authorId) ?? item.authorId.slice(0, 12)}:`,
            item.body,
            'Answer the newest message directly.',
          ]
            .filter(Boolean)
            .join('\n\n');
          const sessionId = this.sessionId!;
          let latestDraft = '';
          const result = await this.client!.sessionPrompt(
            sessionId,
            prompt,
            120_000,
            (_delta, full) => {
              latestDraft = full;
              this.draftTail = this.draftTail
                .catch(() => undefined)
                .then(() =>
                  api.execute('postAgentDraft', {
                    agentId: this.agent.publicKey,
                    roomId: this.options.roomId,
                    turnId: `${this.agent.publicKey}:${this.options.roomId}`,
                    text: latestDraft,
                  }),
                )
                .then(() => undefined)
                .catch((error) =>
                  console.error(
                    `[thin-core] monolith Room ${this.options.roomId} draft publish failed:`,
                    error,
                  ),
                );
            },
          );
          await this.draftTail;
          const reply = stripAgentReplyPreamble(result.agentText).trim();
          if (!reply) throw new Error('ACP turn produced no durable Room reply');
          await api.execute('postRoomMessage', {
            roomId: this.options.roomId,
            requestId: item.id,
            text: reply,
            presentation: 'message',
          });
          await api.execute('retractAgentLiveOutput', {
            agentId: this.agent.publicKey,
            roomId: this.options.roomId,
            turnId: `${this.agent.publicKey}:${this.options.roomId}`,
            kind: 'draft',
          });
        },
        { priority: 'interactive', roomKey: this.options.roomId },
      );
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
        requestId: item.id,
        status: 'complete',
        generationId: `${this.agent.publicKey}:${this.options.roomId}`,
      });
    } catch (error) {
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
        requestId: item.id,
        status: 'failed',
        generationId: `${this.agent.publicKey}:${this.options.roomId}`,
      });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async run(): Promise<void> {
    const { api, roomId, signal } = this.options;
    const status = this.options.config.modelUnavailable ? 'offline' : 'online';
    const postPresence = async (presence: 'online' | 'offline') => {
      await api.execute('postAgentPresence', {
        agentId: this.agent.publicKey,
        roomId,
        status: presence,
      });
      this.options.health.presence(presence);
    };
    await postPresence(status);
    const heartbeat = setInterval(
      () =>
        void postPresence(status).catch((error) =>
          console.error(`[thin-core] monolith Room ${roomId} presence heartbeat failed:`, error),
        ),
      30_000,
    );
    heartbeat.unref?.();
    let cursor: string | undefined;
    try {
      cursor = (await api.execute('getRoomInbox', { roomId, startAtLatest: true })).cursor;
      while (!signal?.aborted) {
        try {
          const inbox = await api.execute('getRoomInbox', {
            roomId,
            ...(cursor ? { after: cursor } : {}),
            limit: 200,
          });
          for (const item of inbox.items) {
            if (item.authorId === this.agent.publicKey || item.type !== 'message') continue;
            const addressed =
              item.mentionIds.includes(this.agent.publicKey) ||
              (item.mentionIds.length === 0 &&
                (await this.roster()).members.filter((member) => member.kind === 'agent').length ===
                  1);
            if (!addressed) continue;
            const authority = await api.execute('getRoomAuthority', {
              roomId,
              principalId: item.authorId,
            });
            if (!authority.member || authority.principalKind !== 'human') continue;
            if (!(await this.currentPrincipalCanDrive(this.options.workspaceId, item.authorId))) {
              continue;
            }
            await this.prompt(item);
          }
          cursor = inbox.cursor ?? cursor;
          this.options.health.poll();
          await wait(this.options.pollMs ?? 1_000, signal);
        } catch (error) {
          if (signal?.aborted) break;
          this.options.health.failure(1_000);
          console.error(`[thin-core] monolith Room ${roomId} turn loop failed:`, error);
          await wait(1_000, signal);
        }
      }
    } finally {
      clearInterval(heartbeat);
      await postPresence('offline').catch((error) =>
        console.error(`[thin-core] monolith Room ${roomId} offline presence failed:`, error),
      );
      await this.options.scheduler.suspend(roomId);
    }
  }
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolveWait) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolveWait();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
