import { maskCredentialResult } from './mask-credential-result.js';
import { CodexPromptDelivery } from './codex-prompt-delivery.js';

import { watch, readFileSync, writeFileSync, type FSWatcher } from 'node:fs';

import { explainAgentProgramFailure } from './agent-command.js';
import { harnessTurnTokens } from './harness-turn-tokens.js';

import { piCompactionMarker } from './pi-session-instructions.js';

import type { SessionMode } from './config.js';
import { cornerAutonomyModeCandidates, roomModeCandidates } from './harness-capabilities.js';
import { harnessReadsMetaSystemPrompt, sessionToolScopeMeta } from './harness-tool-scope.js';
import { AcpClient, isPiAcpHarness, flattenHarnessCause, AcpRuntimeExitedError, AcpResourceLimitError, AcpAvailableCommand, McpServerWire, AcpPromptBlock, AcpTextChunkHandler, AcpStreamHandler, ToolCallEntry, PromptResult, SessionUpdate, toolCallEntries, asyncTaskCall, agentStreamSnapshot, agentMessageChunkText, agentMessageRuns, finalAgentMessageText } from './acp.js';



  export async function acpClientPreparePromptDelivery(ctx: AcpClient, sessionId: string | undefined): Promise<void> {
    if (!sessionId || !isPiAcpHarness(ctx.agentLabel)) return;
    const marker = await piCompactionMarker(sessionId, ctx.agentEnv);
    if (marker === undefined || ctx.piDeliveryMarkers.get(sessionId) !== marker)
      ctx.promptDeliveries.get(sessionId)?.invalidate();
    if (marker !== undefined) ctx.piDeliveryMarkers.set(sessionId, marker);
  }


  export function acpClientPromptDelivery(ctx: AcpClient, sessionId: string | undefined): CodexPromptDelivery | undefined {
    return sessionId ? ctx.promptDeliveries.get(sessionId) : undefined;
  }


  /**
   * One child exit: reject every in-flight request so the turn fails and is
   * reported instead of hanging, then publish the exit. A scoped SIGKILL/137
   * is a likely memory-limit hit, while an unscoped SIGKILL uses the daemon
   * cgroup's OOM counter to distinguish it from a deliberate kill.
   */
  export async function acpClientHandleChildExit(ctx: AcpClient,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const child = ctx.child;
    ctx.alive = false;
    const scope = ctx.resourceScope;
    const memoryLimitLikely = Boolean(scope && !ctx.stopping &&
      (signal === 'SIGKILL' || code === 137));
    const exitText = `ACP agent ${ctx.agentLabel} exited code=${code} signal=${signal}`;
    if (!scope && signal === 'SIGKILL' && !ctx.stopping)
      void ctx.oomKills.consume().then(killed => {
        if (killed) ctx.emit('stderr', `ACP agent ${ctx.agentLabel} was killed by the kernel OOM killer`);
      }).catch(() => undefined);
    const meaningful = flattenHarnessCause(ctx.stderrTail);
    const stderrSuffix = meaningful ? `: ${meaningful}` : '';
    for (const [, p] of ctx.pending) {
      p.reject(memoryLimitLikely
        ? new AcpResourceLimitError(scope!.memoryMaxBytes)
        : new AcpRuntimeExitedError(`${exitText}${stderrSuffix}`));
    }
    ctx.pending.clear();
    ctx.activeRunIds.clear();
    ctx.activePromptSessions.clear();
    ctx.detachedTools.clear();
    ctx.toolCallMetadata.clear();
    ctx.sessionCommands.clear();
    if (scope) {
      await scope.stop().then(() => {
        if (ctx.resourceScope === scope) ctx.resourceScope = undefined;
        if (ctx.child === child) ctx.child = null;
      }).catch((error) => console.error('[acp] resource scope cleanup failed:', error));
    }
    ctx.emit('exit', { code, signal });
  }


  export function acpClientFailRuntime(ctx: AcpClient, detail: string): void {
    ctx.alive = false;
    for (const p of ctx.pending.values()) {
      p.reject(new AcpRuntimeExitedError(detail));
    }
    ctx.pending.clear();
    ctx.emit('exit', { code: null, signal: null });
    if (ctx.resourceScope) void ctx.resourceScope.stop().catch((error) =>
      console.error('[acp] resource scope cleanup failed:', error));
  }


  /** Host pid of the harness wrapper (bwrap when enabled). */
  export function acpClientProcessPid(ctx: AcpClient): number | undefined {
    return ctx.child?.pid;
  }


  /** The latest command list this harness advertised for a session, if any. */
  export function acpClientSessionCommandsFor(ctx: AcpClient, sessionId: string): AcpAvailableCommand[] {
    return ctx.sessionCommands.get(sessionId) ?? [];
  }


  /** Whether this live ACP process advertised the stable `session/load` method. */
  export function acpClientCanLoadSession(ctx: AcpClient): boolean {
    return ctx.supportsSessionLoading;
  }


  /** Whether this live ACP process accepts `image` prompt blocks (`promptCapabilities.image`). */
  export function acpClientCanPromptWithImages(ctx: AcpClient): boolean {
    return ctx.supportsImagePrompts;
  }


  export async function acpClientSessionNew(ctx: AcpClient, opts: {
    cwd: string;
    mcpServers?: McpServerWire[];
    systemPrompt?: string;
    /** Ask agents with ACP modes to enforce the Body session boundary. */
    mode?: SessionMode;
    /** Bounded startup probes use a shorter fail-fast deadline. */
  }): Promise<{ sessionId: string; raw: unknown }> {
    const params: Record<string, unknown> = {
      cwd: opts.cwd,
      mcpServers: ctx.mcpLaunchFiles.prepare(opts.mcpServers ?? [], ctx.agentEnv.HOME).map((s) => ({
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        env: s.env ?? [],
      })),
    };
    if (opts.systemPrompt) {
      // Current ACP SDKs validate the standard field and reject the legacy
      // string with -32602. Older harnesses retain their existing wire form.
      params.systemPrompt = ctx.supportsStructuredSystemPrompt
        ? { mode: 'append', content: [{ type: 'text', text: opts.systemPrompt }] }
        : opts.systemPrompt;
    }
    // The tool-scope lockdown is applied HERE, not at the call sites, so a new
    // session path cannot ship without it: every session/new this daemon sends
    // pins the harness to the servers listed on the same request. See
    // `harness-tool-scope.ts` for what each harness actually honours.
    //
    // `agentLabel`, NOT `agentCommand`: under the OS sandbox the spawn command
    // is `bwrap` and the harness is only an argument to it, so matching on the
    // command would classify every sandboxed session as an unknown harness and
    // silently send no lockdown at all.
    const meta: Record<string, unknown> = {
      ...(sessionToolScopeMeta(ctx.agentLabel, ctx.agentEnv.CLAUDE_CODE_TERMINAL_MCP_TOOLS) ?? {}),
    };
    // Older claude-agent-acp reads only `_meta.systemPrompt`. Keep its fallback;
    // versions advertising the standard field give that field precedence.
    if (opts.systemPrompt && harnessReadsMetaSystemPrompt(ctx.agentLabel)) {
      meta.systemPrompt = { append: opts.systemPrompt };
    }
    if (Object.keys(meta).length > 0) params._meta = meta;
    const raw = (await ctx.request('session/new', params).catch(async error => { throw await explainAgentProgramFailure(error, ctx.agentEnv); })) as Record<
      string,
      unknown
    >;
    const sessionId = raw.sessionId as string | undefined;
    if (!sessionId) throw new Error('session/new missing sessionId');
    if (/(^|[/\\])pi-acp(\.[a-z]+)?$/i.test(ctx.agentLabel) && opts.systemPrompt)
      ctx.piSessionInstructions.remember(sessionId, opts.systemPrompt);
    await ctx.applySessionMode(sessionId, raw, opts.mode);
    if (ctx.codexBlockDelivery)
      ctx.promptDeliveries.set(sessionId, new CodexPromptDelivery(isPiAcpHarness(ctx.agentLabel) ? undefined : opts.systemPrompt));
    return { sessionId, raw };
  }


  /**
   * Reopen a provider-persisted logical conversation in this new ACP process.
   * Unlike `session/new`, load accepts no system prompt: the harness restores
   * its own conversation and instructions instead of receiving transcript
   * text from Body again.
   */
  export async function acpClientSessionLoad(ctx: AcpClient, opts: {
    sessionId: string;
    cwd: string;
    mcpServers?: McpServerWire[];
    mode?: SessionMode;
  }): Promise<{ sessionId: string; raw: unknown }> {
    if (!ctx.supportsSessionLoading) {
      throw new Error('ACP agent does not advertise session/load');
    }
    const params: Record<string, unknown> = {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mcpServers: ctx.mcpLaunchFiles.prepare(opts.mcpServers ?? [], ctx.agentEnv.HOME).map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? [],
      })),
    };
    const meta = sessionToolScopeMeta(ctx.agentLabel);
    if (meta) params._meta = meta;
    ctx.promptDeliveries.delete(opts.sessionId);
    const result = await ctx.request('session/load', params);
    const raw = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    await ctx.applySessionMode(opts.sessionId, raw, opts.mode);
    if (ctx.codexBlockDelivery)
      ctx.promptDeliveries.set(opts.sessionId, new CodexPromptDelivery());
    return { sessionId: opts.sessionId, raw };
  }


  export async function acpClientApplySessionMode(ctx: AcpClient,
    sessionId: string,
    raw: Record<string, unknown>,
    mode: SessionMode | undefined,
  ): Promise<void> {
    if (!mode) return;
    // OpenCode exposes its build/plan agents as a config axis rather than ACP
    // `modes`. Select it at the same lifecycle boundary as other harness modes.
    if (/(^|[/\\])opencode(\.[a-z]+)?$/i.test(ctx.agentLabel)) {
      const options = raw.configOptions as
        | Array<{
            id?: string;
            category?: string;
            currentValue?: string;
            options?: Array<{ value?: string }>;
          }>
        | undefined;
      const axis = options?.find((option) => option.id === 'mode' && option.category === 'mode');
      // A free starter agent's Fly Machine is its own computer: Room work
      // there writes files in its home (the OS sandbox still keeps the rest
      // of the filesystem read-only), so it builds instead of only planning.
      const desired = mode === 'readonly' && !process.env.BEELINE_FREE_AGENT_ID ? 'plan' : 'build';
      if (!axis?.options?.some((option) => option.value === desired)) {
        if (mode === 'readonly' && !ctx.osSandbox) {
          throw new Error('OpenCode did not advertise plan mode for an unsandboxed Room');
        }
        return;
      }
      if (axis.currentValue !== desired) {
        await ctx.request('session/set_config_option', {
          sessionId,
          configId: 'mode',
          value: desired,
        });
      }
      return;
    }
    const modes = raw.modes as
      | {
          availableModes?: Array<{ id?: string }>;
          currentModeId?: string;
        }
      | undefined;
    const candidates =
      mode === 'readonly'
        ? roomModeCandidates(ctx.agentLabel, { osSandbox: ctx.osSandbox })
        : cornerAutonomyModeCandidates(ctx.agentLabel);
    const target = modes?.availableModes?.find(
      (candidate) => candidate.id && candidates.includes(candidate.id),
    )?.id;
    if (!target || modes?.currentModeId === target) return;
    await ctx.request('session/set_mode', { sessionId, modeId: target });
  }


  export async function acpClientSessionPrompt(ctx: AcpClient,
    sessionId: string,
    text: string | readonly AcpPromptBlock[],
    onChunk?: AcpTextChunkHandler,
    onActivity?: AcpStreamHandler,
    onToolCalls?: (calls: readonly ToolCallEntry[]) => void,
    onBackgroundToolCompletion?: (call: ToolCallEntry) => void,
  ): Promise<PromptResult> {
    if (typeof text === 'string') text = await ctx.piSessionInstructions.prepare(sessionId, text, ctx.agentEnv);
    else {
      const blocks = [...text];
      const index = blocks.findIndex(block => block.type === 'text');
      const block = blocks[index];
      if (block?.type === 'text') blocks[index] = { ...block,
        text: await ctx.piSessionInstructions.prepare(sessionId, block.text, ctx.agentEnv) };
      else {
        const prefix = await ctx.piSessionInstructions.prepare(sessionId, '', ctx.agentEnv);
        if (prefix) blocks.unshift({ type: 'text', text: prefix });
      }
      text = blocks;
    }
    ctx.lastPromptByteCount =
      typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : undefined;
    const updates: SessionUpdate[] = [];
    let promptRunId: string | undefined;
    let completed = false;
    let terminalReason: string | undefined;
    let endTurn!: (result: { stopReason: string }) => void;
    const terminal = new Promise<{ stopReason: string }>(resolve => { endTurn = resolve; });
    const contextPath = ctx.agentEnv.BEELINE_TURN_CONTEXT_FILE;
    const stop = (reason: string) => {
      if (terminalReason) return;
      terminalReason = reason;
      ctx.terminalSessions.add(sessionId);
      if (contextPath) {
        try {
          const context = JSON.parse(readFileSync(contextPath, 'utf8'));
          writeFileSync(contextPath, JSON.stringify({ ...context, terminalReason: reason }), { mode: 0o600 });
        } catch (error) {
          ctx.emit('terminal/context-error', error);
        }
      }
      endTurn({ stopReason: reason });
      ctx.sessionCancel(sessionId);
    };
    const isSilentCall = (call: ToolCallEntry) =>
      /^(?:(?:mcp__)?beeline[-_]agent__|mcp\.beeline-agent\.)?no_reply_needed$/.test(call.title ?? '');
    const silentCallPending = () => toolCallEntries(updates).some(call =>
      isSilentCall(call) && !call.resultReceived && !['completed', 'failed'].includes(call.status ?? ''));
    let toolsSettled: (() => void) | undefined;
    const checkTerminalContext = () => {
      if (!contextPath || terminalReason) return;
      try {
        const context = JSON.parse(readFileSync(contextPath, 'utf8'));
        // Keep the originating authority until the MCP result has reached the
        // harness. Cancelling earlier turns a successful silence into a failed
        // background call, whose completion would otherwise wake another turn.
        if (context.terminalReason === 'no-reply' && silentCallPending()) return;
        if (context.terminalReason) stop(context.terminalReason);
      } catch { /* A context rewrite can briefly be empty. */ }
    };
    let watcher: FSWatcher | undefined;
    if (contextPath) watcher = watch(contextPath, checkTerminalContext);
    const stable = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stable);
      if (value && typeof value === 'object') return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]),
      );
      return value;
    };
    const asyncTasks = new Map<string, ToolCallEntry>();
    const asyncToolCallIds = new Set<string>();
    const onUpdate = (u: SessionUpdate) => {
      if (u.sessionId !== sessionId || terminalReason) return;
      if (['tool_call', 'tool_call_update', 'tool_result'].includes(String(u.update.sessionUpdate))) {
        const calls = toolCallEntries(updates);
        const previous = u.update.toolCallId
          ? calls.find(call => call.id === u.update.toolCallId)
          : u.update.sessionUpdate === 'tool_call' ? undefined : calls.at(-1);
        u = { ...u, update: maskCredentialResult(u.update, { ...previous, ...u.update }) };
      }
      updates.push(u);
      if (!silentCallPending()) toolsSettled?.();
      checkTerminalContext();
      if (terminalReason) return;
      const task = asyncTaskCall(u.update);
      if (task?.id) {
        asyncTasks.set(task.id, { ...asyncTasks.get(task.id), ...task });
        if (typeof u.update.toolCallId === 'string') asyncToolCallIds.add(u.update.toolCallId);
      }
      promptRunId ??= ctx.activeRunIdFromUpdate(u.update);
      onActivity?.(agentStreamSnapshot(updates, ctx.agentLabel));
      const calls = toolCallEntries(updates);
      onToolCalls?.(calls);
      let previous: string | undefined;
      let repeats = 0;
      for (const call of calls) {
        if (!call.title || (!call.resultReceived && !['completed', 'failed'].includes(call.status ?? ''))) {
          previous = undefined;
          repeats = 0;
          continue;
        }
        const key = JSON.stringify([call.title, stable(call.rawInput ?? {}),
          call.status === 'failed', stable(call.content), stable(call.rawOutput)]);
        repeats = key === previous ? repeats + 1 : 1;
        previous = key;
        if (repeats === 5) {
          stop('repeated-tool-call');
          return;
        }
      }
      if (onChunk) {
        const delta = agentMessageChunkText(u.update);
        if (delta) {
          const runs = agentMessageRuns(updates, ctx.agentLabel);
          onChunk(delta, runs.join('\n\n'), runs.at(-1), runs);
        }
      }
    };
    ctx.on('session/update', onUpdate);
    ctx.activePromptSessions.add(sessionId);

    try {
      const result = (await Promise.race([terminal, ctx.request(
        'session/prompt',
        {
          sessionId,
          prompt: typeof text === 'string' ? [{ type: 'text', text }] : [...text],
        },
      )])) as { stopReason?: string };

      // Some harnesses return end_turn before background MCP calls finish.
      // Silence is part of this turn, never a detached job or a new trigger.
      if (!terminalReason && silentCallPending()) {
        let runtimeExited: (() => void) | undefined;
        try {
          await Promise.race([terminal, new Promise<void>((resolve, reject) => {
            toolsSettled = resolve;
            runtimeExited = () => reject(new AcpRuntimeExitedError('runtime exited awaiting no_reply_needed result'));
            ctx.once('exit', runtimeExited);
            if (!ctx.alive) runtimeExited();
          })]);
        } finally {
          if (runtimeExited) ctx.off('exit', runtimeExited);
          toolsSettled = undefined;
        }
      }
      checkTerminalContext();
      const agentText = terminalReason === 'free-agent-time-limit'
        ? agentMessageRuns(updates, ctx.agentLabel).join('\n\n')
        : terminalReason ? '' : finalAgentMessageText(updates, ctx.agentLabel);

      const toolCalls = toolCallEntries(updates);
      completed = !terminalReason;
      const tokenUsage = harnessTurnTokens(result, updates);

      return {
        stopReason: terminalReason ?? result?.stopReason ?? 'end_turn',
        updates,
        agentText,
        toolCalls,
        ...(tokenUsage ? { tokenUsage } : {}),
      };
    } finally {
      ctx.promptDeliveries.get(sessionId)?.complete(completed);
      if (!completed) ctx.piSessionInstructions.failed(sessionId);
      watcher?.close();
      for (const [id, pending] of ctx.pending) {
        if (terminalReason && pending.sessionId === sessionId) {
          ctx.pending.delete(id);
          pending.resolve({ stopReason: terminalReason });
        }
      }
      ctx.activePromptSessions.delete(sessionId);
      ctx.emit('prompt/end', { sessionId });
      if (promptRunId && ctx.activeRunIds.get(sessionId) === promptRunId) {
        ctx.activeRunIds.delete(sessionId);
      }
      ctx.off('session/update', onUpdate);
      if (onBackgroundToolCompletion) {
        for (const call of [...toolCallEntries(updates), ...asyncTasks.values()]) {
          if (!isSilentCall(call) && call.id && !asyncToolCallIds.has(call.id) && !call.id.startsWith('anonymous-') &&
              !['completed', 'failed'].includes(call.status ?? '') && !call.resultReceived) {
            const key = `${sessionId}\0${call.id}`;
            // Progress during another turn must retain the job's original order.
            if (!ctx.detachedTools.has(key)) ctx.detachedTools.set(key, {
              call, complete: onBackgroundToolCompletion,
            });
          }
        }
      }
    }
  }
