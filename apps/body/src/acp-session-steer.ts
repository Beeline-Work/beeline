import { AcpClient, flattenHarnessCause, AcpRuntimeExitedError, SessionUpdate, toolCallEntries, asyncTaskCall, SteerResult, AcpRequestError, parseAcpUsage, parseAvailableCommands, AcpPermissionRequest, AcpPermissionDecision } from './acp.js';



  /**
   * Inject follow-up input into the prompt currently running for this session.
   * buzz-agent advertises the target run through ACP session metadata; binding
   * the request to that id prevents a late message from steering a newer turn.
   */
  export async function acpClientSessionSteer(ctx: AcpClient, sessionId: string, text: string): Promise<SteerResult> {
    if (ctx.supportsStandardSteering) {
      const raw = (await ctx.request(
        '_session/steering',
        {
          sessionId,
          prompt: [{ type: 'text', text }],
        },
      )) as { outcome?: string };
      if (!raw.outcome || raw.outcome === 'failed') {
        throw new Error('ACP session steering failed');
      }
      return {
        runId: ctx.activeRunId(sessionId) ?? `session:${sessionId}`,
        messageId: raw.outcome,
      };
    }
    const expectedRunId = await ctx.waitForActiveRun(sessionId);
    const raw = (await ctx.request(
      '_goose/unstable/session/steer',
      {
        sessionId,
        prompt: [{ type: 'text', text }],
        expectedRunId,
      },
    )) as { runId?: string; messageId?: string };
    if (!raw.runId || !raw.messageId) {
      throw new Error('ACP session steer response missing runId or messageId');
    }
    return { runId: raw.runId, messageId: raw.messageId };
  }


  /** Active ACP run for a session, if the agent has advertised one. */
  export function acpClientActiveRunId(ctx: AcpClient, sessionId: string): string | undefined {
    return (
      ctx.activeRunIds.get(sessionId) ??
      (ctx.activePromptSessions.has(sessionId) ? `session:${sessionId}` : undefined)
    );
  }


  export function acpClientSessionCancel(ctx: AcpClient, sessionId: string): void {
    ctx.notify('session/cancel', { sessionId });
  }


  /**
   * The portable model/effort setter, confirmed round-tripping on pi/codex/
   * claude (report `data/buzzy-multiagent-runtimes/report.md` §3.2). The
   * param is `configId`, not `optionId`. Harnesses that advertise this shape
   * must use it; `session/set_model` is reserved for the distinct standard
   * `session/new.models` shape. Returns the runtime's updated `configOptions`.
   * Callers must validate `configId`/`value` against the
   * allow-listed catalog before calling this — see
   * `apps/body/src/model-config.ts`'s `assertModelConfigOptionAllowed`; this
   * method performs no policy checks of its own.
   */
  export async function acpClientSetConfigOption(ctx: AcpClient, sessionId: string, configId: string, value: string): Promise<unknown> {
    return ctx.request('session/set_config_option', { sessionId, configId, value });
  }


  /**
   * Standard ACP model setter used only when `session/new.models` supplied the
   * corresponding safe model axis. Most Beeline harnesses use configOptions;
   * Grok currently exposes models through this standard method instead.
   */
  export async function acpClientSetModel(ctx: AcpClient, sessionId: string, modelId: string): Promise<unknown> {
    return ctx.request('session/set_model', { sessionId, modelId });
  }


  export function acpClientOnData(ctx: AcpClient, chunk: string): void {
    ctx.buf += chunk;
    let nl: number;
    while ((nl = ctx.buf.indexOf('\n')) >= 0) {
      const line = ctx.buf.slice(0, nl).trim();
      ctx.buf = ctx.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      ctx.handleMessage(msg);
    }
  }


  export function acpClientHandleMessage(ctx: AcpClient, msg: Record<string, unknown>): void {
    const id = msg.id;
    const method = msg.method as string | undefined;
    // Response to our request.
    if (id !== undefined && !method) {
      const n = Number(id);
      const p = ctx.pending.get(n);
      if (!p) return;
      ctx.pending.delete(n);
      if (msg.error) {
        const err = msg.error as { code?: number; message?: string; data?: { details?: unknown } };
        const details =
          typeof err.data?.details === 'string' && err.data.details.trim()
            ? err.data.details.replace(/\s+/g, ' ').trim()
            : '';
        const meaningful = flattenHarnessCause(ctx.stderrTail);
        const extra = [details, meaningful ? `harness stderr: ${meaningful}` : '']
          .filter(Boolean)
          .join('; ');
        p.reject(new AcpRequestError(err.code, `ACP error ${err.code}: ${err.message}${extra ? `; ${extra}` : ''}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Agent → client request (has id + method).
    if (method && id !== undefined) {
      if (method === 'session/request_permission') {
        void ctx.handlePermission(id, msg.params);
        return;
      }
      // Unknown request — cancel/empty result.
      ctx.write({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    // Notifications (no id).
    if (method === 'session/update') {
      const params = msg.params as { sessionId?: string; update?: Record<string, unknown> };
      if (params?.sessionId && params.update) {
        if (params.update.sessionUpdate === 'compaction_update' ||
            params.update.sessionUpdate === 'compaction_summary_chunk')
          ctx.promptDeliveries.get(params.sessionId)?.invalidate();
        // Harness-advertised slash commands/skills: captured here so the daemon
        // can republish them as the agent's durable command list (see
        // `agent-commands.ts` in buzz-client). Arrival is adapter-driven — all
        // shipped adapters push it at session start and on mid-session change.
        if (params.update.sessionUpdate === 'usage_update') {
          const usage = parseAcpUsage(params.update, ctx.sessionUsage.get(params.sessionId));
          if (usage) {
            ctx.sessionUsage.set(params.sessionId, usage);
            ctx.usageHandler?.(usage);
          }
        }
        if (params.update.sessionUpdate === 'available_commands_update') {
          const commands = parseAvailableCommands(params.update.availableCommands);
          ctx.sessionCommands.set(params.sessionId, commands);
          ctx.commandsHandler?.(commands);
          ctx.emit('commands', { sessionId: params.sessionId, commands });
        }
        const toolCallId = params.update.toolCallId;
        const sessionUpdate = params.update.sessionUpdate;
        if (
          typeof toolCallId === 'string' &&
          (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update')
        ) {
          const metadataKey = `${params.sessionId}\0${toolCallId}`;
          const status = params.update.status;
          if (status === 'completed' || status === 'failed') {
            ctx.toolCallMetadata.delete(metadataKey);
          } else {
            const existing = ctx.toolCallMetadata.get(metadataKey);
            ctx.toolCallMetadata.set(metadataKey, {
              ...existing,
              toolCallId,
              ...(typeof params.update.name === 'string' ? { name: params.update.name } : {}),
              ...(typeof params.update.title === 'string' ? { title: params.update.title } : {}),
              ...(typeof params.update.kind === 'string' ? { kind: params.update.kind } : {}),
              ...('rawInput' in params.update ? { rawInput: params.update.rawInput } : {}),
              // `content`/`locations` carry the touched file paths for adapters
              // whose permission request omits them (codex-acp's file-change
              // request has no rawInput at all) — the corner worktree guard in
              // `session-sandbox.ts` reads them.
              ...('content' in params.update ? { content: params.update.content } : {}),
              ...('locations' in params.update ? { locations: params.update.locations } : {}),
            });
          }
        }
        const u: SessionUpdate = {
          sessionId: params.sessionId,
          update: params.update,
        };
        const activeRunId = ctx.activeRunIdFromUpdate(params.update);
        if (activeRunId) ctx.activeRunIds.set(params.sessionId, activeRunId);
        const task = asyncTaskCall(params.update);
        const key = `${params.sessionId}\0${task?.id ?? String(params.update.toolCallId ?? '')}`;
        const detached = ctx.detachedTools.get(key);
        if (detached) {
          detached.call = { ...detached.call, ...(task ?? toolCallEntries([u])[0]) };
          if (detached.call.status === 'completed' || detached.call.status === 'failed' ||
              detached.call.resultReceived) {
            ctx.detachedTools.delete(key);
            detached.complete(detached.call);
          }
        }
        ctx.emit('session/update', u);
      }
      return;
    }
  }


  export function acpClientActiveRunIdFromUpdate(_ctx: AcpClient, update: Record<string, unknown>): string | undefined {
    const meta = update._meta as Record<string, unknown> | undefined;
    const goose = meta?.goose as Record<string, unknown> | undefined;
    return typeof goose?.activeRunId === 'string' && goose.activeRunId
      ? goose.activeRunId
      : undefined;
  }


  export function acpClientWaitForActiveRun(ctx: AcpClient, sessionId: string): Promise<string> {
    const current = ctx.activeRunIds.get(sessionId);
    if (current) return Promise.resolve(current);
    if (!ctx.activePromptSessions.has(sessionId)) return Promise.reject(new Error('No active prompt to steer'));

    return new Promise((resolve, reject) => {
      const onUpdate = (update: SessionUpdate) => {
        if (update.sessionId !== sessionId) return;
        const runId = ctx.activeRunIdFromUpdate(update.update);
        if (!runId) return;
        cleanup();
        resolve(runId);
      };
      const exited = () => { cleanup(); reject(new AcpRuntimeExitedError('runtime exited before an active run was advertised')); };
      const ended = (event: { sessionId: string }) => { if (event.sessionId === sessionId) { cleanup(); reject(new Error('Prompt ended before an active run was advertised')); } };
      const cleanup = () => {
        ctx.off('session/update', onUpdate);
        ctx.off('exit', exited);
        ctx.off('prompt/end', ended);
      };
      ctx.on('prompt/end', ended);
      ctx.once('exit', exited);
      ctx.on('session/update', onUpdate);
    });
  }


  export async function acpClientHandlePermission(ctx: AcpClient, id: unknown, params: unknown): Promise<void> {
    const p = (params ?? {}) as AcpPermissionRequest;
    if (p.sessionId && ctx.terminalSessions.has(p.sessionId)) {
      ctx.write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    const toolCallId = p.toolCall?.toolCallId;
    const metadataKey = p.sessionId && toolCallId ? `${p.sessionId}\0${toolCallId}` : undefined;
    const tracked = metadataKey ? ctx.toolCallMetadata.get(metadataKey) : undefined;
    if (tracked) p.toolCall = { ...tracked, ...p.toolCall };
    let decision: AcpPermissionDecision = ctx.autoApprove ? 'allow' : 'reject';
    if (!ctx.autoApprove && ctx.permissionAllowlist) {
      try {
        decision = ctx.permissionAllowlist(p) ? 'allow' : 'reject';
      } catch (error) {
        ctx.emit('permission/error', error);
        decision = 'reject';
      }
    } else if (ctx.permissionHandler) {
      try {
        decision = await ctx.permissionHandler(p);
      } catch (error) {
        ctx.emit('permission/error', error);
        decision = 'reject';
      }
    }
    if (p.sessionId && ctx.terminalSessions.has(p.sessionId)) decision = 'reject';
    if (decision === 'allow') {
      const allow =
        p?.options?.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') ??
        p?.options?.[0];
      if (allow?.optionId) {
        if (metadataKey) ctx.toolCallMetadata.delete(metadataKey);
        ctx.write({
          jsonrpc: '2.0',
          id,
          result: {
            outcome: { outcome: 'selected', optionId: allow.optionId },
          },
        });
        return;
      }
    }
    // Reject if we cannot approve.
    const reject = p?.options?.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
    if (reject?.optionId) {
      if (metadataKey) ctx.toolCallMetadata.delete(metadataKey);
      ctx.write({
        jsonrpc: '2.0',
        id,
        result: {
          outcome: { outcome: 'selected', optionId: reject.optionId },
        },
      });
      return;
    }
    if (metadataKey) ctx.toolCallMetadata.delete(metadataKey);
    ctx.write({
      jsonrpc: '2.0',
      id,
      result: { outcome: { outcome: 'cancelled' } },
    });
  }


  /** Responses and transport loss settle requests; silence never starts a retry. */
  export function acpClientRequest(ctx: AcpClient, method: string, params: unknown): Promise<unknown> {
    if (!ctx.child || !ctx.alive)
      return Promise.reject(new AcpRuntimeExitedError('ACP process is not running'));
    const id = ctx.nextId++;
    return new Promise((resolve, reject) => {
      const sessionId = (params as { sessionId?: string })?.sessionId;
      ctx.pending.set(id, { resolve, reject, ...(sessionId ? { sessionId } : {}) });
      ctx.write({ jsonrpc: '2.0', id, method, params });
    });
  }


  export function acpClientNotify(ctx: AcpClient, method: string, params: unknown): void {
    ctx.write({ jsonrpc: '2.0', method, params });
  }


  export function acpClientWrite(ctx: AcpClient, obj: unknown): void {
    if (!ctx.child?.stdin.writable) {
      if (ctx.child) ctx.failRuntime(`ACP agent ${ctx.agentLabel} stdin pipe closed`);
      return;
    }
    ctx.child.stdin.write(JSON.stringify(obj) + '\n', (error) => {
      if (error) ctx.failRuntime(`stdin: ${error.message}`);
    });
  }
