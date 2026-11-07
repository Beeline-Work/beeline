import { prepareRoomGitDirectory } from './room-checkout-tools.js';
import { postChangedAgentUsage } from './helper-usage-binding.js';
import { agentBehavior } from './agent-command.js';
import { installRoomGitHubLauncher } from './room-github-auth.js';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { machineHost } from './machine-host.js';
import { markWorkspaceLayoutLive, prepareCodexCacheTargets, preparePackageCacheTargets, preparePrivateAssets, prepareWorkspaceAssets, workspaceAssetPaths, workspaceCacheEnv } from './workspace-assets.js';
import { admitSharedAssets } from './shared-asset-capacity.js';
import { AcpClient, openAcpConversation, type McpServerWire, type PromptResult } from './acp.js';
import { expectedMountedImportedMcpServerNames, grantedSquireHostBindPaths, harnessStateDirsFromEnv, hostImportedMcpDeclarations, hostImportedMcpServerNames, prepareRoomAgentHome } from './agent-home.js';
import { grantedHostRouteWires, grantedSquireHostRoute, ungatedHostServers } from './host-mcp-route.js';
import { openRouterRoutingInput } from './openrouter-routing.js';
import { agentOpenRouterKey } from './openrouter-key-usage.js';
import { agentCommandCatalogPublisher } from './agent-command-catalog.js';
import { installPiMcpBridge } from './pi-mcp-bridge.js';
import { installPiTurnBudget } from './pi-turn-budget.js';
import { beelineAgentMcpServer, writeSessionResourceAuth, recordSessionModelFallback, tracedAgentProcessLifecycle, readOnlyMcpServer } from './room-session.js';
import { modelContextWindowTokens } from './model-context-window.js';
import { codegraphFingerprintServers, codegraphIndexDirectory, codegraphMcpServer, prepareCodegraphIndex } from './codegraph.js';
import { sessionConfigFingerprint } from './session-config-fingerprint.js';
import { registryMcpHostBindPaths, registryMcpHostDeclarations } from './registry-mcp.js';
import { credentialMaskPaths, harnessHomeStateDirs, siblingAgentMaskPaths, wrapAgentCommand, type SandboxSessionSpec } from './bwrap-sandbox.js';
import { harnessIdentityLabel, sessionNewMcpServers } from './cursor-acp-bridge.js';
import { bodyAgentCommand } from './config.js';
import { explainEmptyAgentTurn, isSilentCompletion, nextPinnedProvider, type EmptyTurnExplanation } from './empty-turn.js';
import { roomNativeIoProven, roomShellCapability } from './harness-capabilities.js';
import { agentArgsWithModelSelection, applyAgentModelSelection, filterAllowedModelConfigOptions, parseAdvertisedConfigOptions } from './model-config.js';
import { runtimeDirectory } from './runtime.js';
import { assembleSessionPrompt } from './prompt-assembly.js';
import { durableReplyText } from './turn-stream.js';
import { TurnTrace } from './turn-trace.js';
import { isPrivateWorkToolCall } from './tool-call-failure.js';
import { turnErrorDetail } from './turn-failure-reason.js';
import { startAgentProcess, stopAgentProcess, type AgentProcessLifecycle } from './agent-process.js';
import { MonolithRoomTurnLoop, execFileAsync, roomPermissionDecision, HumanMessage, ActiveTurn } from './monolith-room-turn.js';



  export async function monolithRoomTurnLoopActivateCold(ctx: MonolithRoomTurnLoop, trace: TurnTrace | undefined, startupStep: (step: string) => void): Promise<string> {
    trace?.noteActivation('cold');
    ctx.sectionBaseline.reset();
    const [configuration, roster, repositoryState, grants] =
      await Promise.all([
        ctx.configuration(),
        ctx.roster(),
        ctx.repositoryState(),
        ctx.grantedResources(),
        ]);
    const { hostRoutes: grantedHostRoutes, devices: grantedDevices, isolatedCategories } = grants;
    startupStep('configuration');
    ctx.isolatedCategories = isolatedCategories;
    const privateAssetRoot = join(runtimeDirectory(ctx.options.runtime.supervisorRoot,
      ctx.options.runtime.agent.publicKey), 'private-assets');
    const self = roster.members.find((member) => member.identityId === ctx.agent.publicKey);
    const directMessage =
      Array.isArray(repositoryState.directParticipants) &&
      repositoryState.directParticipants.length === 2;
    await mkdir(ctx.options.cwd, { recursive: true });
    const selectionModel = configuration.model ?? ctx.options.config.modelSelection?.model;
    const selectionEffort = configuration.effort ?? ctx.options.config.modelSelection?.effort;
    const selection = {
      model: selectionModel,
      effort: selectionEffort,
      fastMode: configuration.fastMode,
    };
    ctx.openRouterKey = agentOpenRouterKey(
      ctx.options.config.agentKind, selection.model, ctx.options.config.agentEnv,
    );
    const operatorHome = ctx.options.config.operatorHome ?? homedir();
    const registryHostDeclarations = registryMcpHostDeclarations(
      configuration.registryMcpRoutes,
      ctx.commandContext.path,
      ctx.options.config.registryMcpBrokerSocket,
    );
    const mountedHostRoutes = [...grantedHostRoutes, ...Object.keys(registryHostDeclarations)];
    const squireScope = {
      agentId: ctx.agent.publicKey,
      roomId: ctx.options.roomId,
      ...(grantedSquireHostRoute(mountedHostRoutes, {
        ...hostImportedMcpDeclarations({ operatorHome, agentKind: ctx.options.config.agentKind }),
        ...registryHostDeclarations,
      })
        ? { relay: await ctx.squireRelay.listen(ctx.commandContext.path) }
        : {}),
    };
    const resourceAuthFile = await writeSessionResourceAuth(ctx.options.api, ctx.commandContext.path);
    const homeOverlay = ctx.options.config.agentHomeRoot
      ? await prepareRoomAgentHome({
          root: ctx.options.config.agentHomeRoot,
          squireScope,
          sharedSkills: ctx.options.config.sharedSkills ?? [],
          isReviewer: configuration.isReviewer === true,
          grantedHostRoutes: mountedHostRoutes,
          extraHostRoutes: registryHostDeclarations,
          resourceAuthFile,
          ...(ctx.options.config.agentKind ? { agentKind: ctx.options.config.agentKind } : {}),
          ...(ctx.options.config.operatorHome
            ? { operatorHome: ctx.options.config.operatorHome }
            : {}),
          ...openRouterRoutingInput(ctx.options.config, selection, ctx.options.fetchImpl, {
            ...(ctx.pinnedProviderOverride
              ? { providerOverride: ctx.pinnedProviderOverride }
              : {}),
            onDecision: (routing) => {
              // The override pins one provider; keep the full order it came
              // from so a later empty turn still knows what to rotate to.
              if (!ctx.pinnedProviderOverride) ctx.pinnedProviders = [...routing.providers];
              // A pinned model that takes no images is a fact about THIS
              // session (C87): the harness still advertises the capability,
              // so without this the turn would ship megabytes the model never
              // sees and say nothing about why (`modelTakesImages`).
              ctx.modelTakesImages = routing.input ? routing.input.includes('image') : undefined;
            },
          }),
        })
      : {};
    const command = bodyAgentCommand(ctx.options.config);
    startupStep('home');
    const harnessLabel = harnessIdentityLabel({
      kind: ctx.options.config.agentKind,
      command,
    });
    let assets = ctx.options.config.agentSharedAssetRoot && ctx.options.config.bwrapPath && homeOverlay.HOME &&
      await admitSharedAssets(ctx.options.runtime.supervisorRoot, 1024 ** 3)
      ? await prepareWorkspaceAssets(ctx.options.config.agentSharedAssetRoot)
      : undefined;
    startupStep('asset-layout');
    if (isolatedCategories.length)
      await preparePrivateAssets(privateAssetRoot, isolatedCategories);

    ctx.sharedAssetsActive = Boolean(assets);
    startupStep('toolchain');
    const cacheEnv = assets
      ? workspaceCacheEnv(assets, undefined,
          isolatedCategories.includes('package-cache') ? privateAssetRoot : undefined)
      : isolatedCategories.includes('package-cache')
        ? workspaceCacheEnv(workspaceAssetPaths(privateAssetRoot), undefined, privateAssetRoot)
        : {};
    if (assets && agentBehavior(ctx.options.config.agentKind).codexCacheBindings && homeOverlay.CODEX_HOME)
      await prepareCodexCacheTargets(homeOverlay.CODEX_HOME);
    if (assets && homeOverlay.HOME) await preparePackageCacheTargets(homeOverlay.HOME);
    await Promise.all(
      Object.values(cacheEnv).map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
    );
    if (assets && ctx.options.config.agentPrivateRoot)
      await mkdir(ctx.options.config.agentPrivateRoot, { recursive: true, mode: 0o700 });
    const agentEnv: Record<string, string> = {
      ...ctx.options.config.agentEnv,
      ...homeOverlay,
      ...cacheEnv,
      BEELINE_TURN_CONTEXT_FILE: ctx.commandContext.path,
    };
    // Keep an explicitly configured credential ahead of the repository App.
    // Tokens are not part of a persisted fingerprint or prompt.
    const githubToken =
      agentEnv.GH_TOKEN || agentEnv.GITHUB_TOKEN || ctx.turnCheckout?.githubToken;
    if (githubToken) {
      agentEnv.GH_TOKEN = githubToken;
      agentEnv.GITHUB_TOKEN = githubToken;
    }
    if (ctx.turnCheckout?.githubToken && ctx.options.config.agentHomeRoot) {
      const ghBinary = await execFileAsync('which', ['gh'], { env: agentEnv })
        .then((result) => result.stdout.trim())
        .catch(() => undefined);
      if (ghBinary)
        agentEnv.PATH = await installRoomGitHubLauncher({
          root: ctx.options.config.agentHomeRoot,
          ghBinary,
          inheritedPath: agentEnv.PATH ?? '',
          resourceAuthFile,
          registryBrokerSocket: ctx.options.config.registryMcpBrokerSocket,
          ...(squireScope.relay ? { relay: squireScope.relay } : {}),
        });
    }

    const selectedCommand = command;
    ctx.agentEnv = agentEnv;
    ctx.modelContextTokens = await modelContextWindowTokens(
      selectionModel,
      agentEnv.PI_CODING_AGENT_DIR,
    );
    const agentArgs = agentArgsWithModelSelection(
      {
        kind: ctx.options.config.agentKind,
        command,
        args: ctx.options.config.agentArgs ?? [],
      },
      selection,
    );
    const { stateDirs, tmpDir } = harnessStateDirsFromEnv(agentEnv);
    ctx.attachmentDir = tmpDir ? join(tmpDir, 'beeline-attachments') : undefined;
    ctx.sessionScratchDir = tmpDir;
    ctx.sessionStateDirs = stateDirs;
    const homeStateDirs = harnessHomeStateDirs(harnessLabel, agentEnv.HOME ?? operatorHome);
    await Promise.all(homeStateDirs.map((dir) => mkdir(dir, { recursive: true })));
    // The same path handed to the MCP server as BEELINE_ATTACH_SCRATCH_ROOT
    // (below): post_artifact can only post what write_scratch_file could write,
    // so the sandbox must leave this writable too.
    const attachScratchRoot = ctx.options.config.agentHomeRoot ?? tmpDir;
    if (attachScratchRoot) await mkdir(attachScratchRoot, { recursive: true });
    // Index before constructing the sandbox: a Room keeps the checkout
    // read-only, but CodeGraph's SQLite WAL and connect-time reconciliation
    // need its generated .codegraph directory writable while the MCP lives.
    const codegraphReady = await prepareCodegraphIndex(ctx.options.config, ctx.options.cwd);
    const fingerprint = sessionConfigFingerprint({
      devices: grantedDevices,
      isolatedCategories,
      model: configuration.model ?? ctx.options.config.modelSelection?.model,
      effort: configuration.effort ?? ctx.options.config.modelSelection?.effort,
      fastMode: configuration.fastMode,
      soul: configuration.soul ?? self?.soul,
      agentName: self?.name ?? ctx.agent.name,
      mcpServers: codegraphFingerprintServers(
        ctx.options.config,
        [
          ...expectedMountedImportedMcpServerNames({
            operatorHome: ctx.options.config.operatorHome,
            agentKind: ctx.options.config.agentKind,
            grantedHostRoutes: mountedHostRoutes,
          }),
          ...Object.keys(registryHostDeclarations),
        ],
        codegraphReady,
      ),
    });
    const sandboxSpec: SandboxSessionSpec = {
      mode: 'readonly',
      cwd: ctx.options.cwd,
      harnessStateDirs: stateDirs,
      harnessHomeStateDirs: homeStateDirs,
      ...(tmpDir ? { tmpDir } : {}),
      additionalWritablePaths: [
        ...(ctx.options.config.browserShareHostSocket ? [dirname(ctx.options.config.browserShareHostSocket)] : []),
        ...(attachScratchRoot ? [attachScratchRoot] : []),
        ...(codegraphReady ? [codegraphIndexDirectory(ctx.options.cwd)] : []),
        ...registryMcpHostBindPaths(
          configuration.registryMcpRoutes,
          ctx.options.config.registryMcpBrokerSocket,
        ),
        ...grantedSquireHostBindPaths({
          operatorHome,
          agentKind: ctx.options.config.agentKind,
          grantedHostRoutes: mountedHostRoutes,
        }),
      ],
      devices: grantedDevices,
      maskPaths: [
        ...credentialMaskPaths(ctx.options.config.sandboxMaskPaths, operatorHome),
        ...(assets ? [] : siblingAgentMaskPaths(
          runtimeDirectory(ctx.options.runtime.supervisorRoot, ctx.options.runtime.agent.publicKey),
        )),
      ],
      ...(assets && ctx.options.config.agentHomeRoot
        ? { sharedLayout: {
            assetRoot: assets.root,
            agentRuntimeDir: runtimeDirectory(ctx.options.runtime.supervisorRoot, ctx.options.runtime.agent.publicKey),
            privateHomeRoot: ctx.options.config.agentHomeRoot,
            ...(ctx.options.config.agentPrivateRoot ? { privateRoot: ctx.options.config.agentPrivateRoot } : {}),
            ...(agentBehavior(ctx.options.config.agentKind).codexCacheBindings && agentEnv.CODEX_HOME ? { codexHome: agentEnv.CODEX_HOME } : {}),
            ...(agentEnv.HOME ? { packageHome: agentEnv.HOME } : {}),
            privateAssetRoot,
            isolatedCategories,
          } }
        : {}),
    };
    if (ctx.options.config.bwrapPath && ctx.options.config.agentHomeRoot) {
      sandboxSpec.roomGitDirectory = await prepareRoomGitDirectory(ctx.options.cwd, ctx.options.config.agentHomeRoot,
        { bwrapPath: ctx.options.config.bwrapPath, spec: sandboxSpec });
    }
    const spawnCommand = wrapAgentCommand({
      bwrapPath: ctx.options.config.bwrapPath, spec: sandboxSpec,
      command: selectedCommand, args: agentArgs,
    });
    // Built before the client: the permission allowlist resolves a harness's
    // own tool-dispatch envelope (grok's `use_tool`) against exactly the
    // servers this session mounts, so it has to know them up front.
    const shellCapability = roomShellCapability(harnessLabel, {
      osSandbox: Boolean(ctx.options.config.bwrapPath),
    });
    const servers: McpServerWire[] = [
      ...(shellCapability === 'runs'
        ? []
        : [
            readOnlyMcpServer(
              ctx.options.config,
              ctx.options.cwd,
              undefined,
              githubToken,
              agentEnv.PATH,
            ),
          ]),
      beelineAgentMcpServer(ctx.options.config, ctx.options.api, {
        roomId: ctx.options.roomId,
        workspaceId: ctx.options.workspaceId,
        attachRoot: ctx.options.cwd,
        // The whole per-session overlay, not an enumerated subset: the agent
        // never picks where a harness writes a file it generates (grok's own
        // images dir, say), so anything inside the overlay it could possibly
        // have written must be attachable, whatever subdirectory that is.
        attachScratchRoot,
        turnContextPath: ctx.commandContext.path,
        directMessage,
        nativeIoProven: roomNativeIoProven(harnessLabel, { osSandbox: Boolean(ctx.options.config.bwrapPath) }),
        agentCommand: harnessLabel,
        squireRelay: squireScope.relay,
        ...(ctx.options.grantRunnerEndpoint && ctx.options.config.bwrapPath
          ? { grantRunner: ctx.options.grantRunnerEndpoint }
          : {}),
      }),
    ];
    if (codegraphReady) {
      const codegraph = codegraphMcpServer(ctx.options.config, ctx.options.cwd, {
        readonly: true,
      });
      if (codegraph) servers.push(codegraph);
    }
    const hostDeclarations = hostImportedMcpDeclarations({
      operatorHome,
      agentKind: ctx.options.config.agentKind,
    });
    const grantedRouteServers = grantedHostRouteWires(
      mountedHostRoutes,
      operatorHome,
      { ...hostDeclarations, ...registryHostDeclarations },
      resourceAuthFile,
      squireScope,
    );
    const sessionServers = sessionNewMcpServers<McpServerWire>(harnessLabel, servers, grantedRouteServers);
    // Pi ACP ignores session/new MCP servers. The installer selects native
    // mcp.json or the generated bridge for this executable and isolated home.
    await installPiTurnBudget(agentEnv.PI_CODING_AGENT_DIR);
    await installPiMcpBridge({
      agentCommand: harnessLabel,
      piHome: agentEnv.PI_CODING_AGENT_DIR,
      piCommand: agentEnv.PI_ACP_PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND,
      agentEnv,
      servers: [...servers, ...grantedRouteServers],
    });
    startupStep('mcp-bridge');
    // What this session actually mounted, not only the Beeline-owned servers:
    // the isolated home also holds every copied local import and every granted
    // host route. A harness that names the tool but never the protocol (grok's
    // `use_tool` envelope) can only be resolved against this list, so a name
    // missing here is a mounted server the agent could never call.
    const mountedServers = [
      ...servers.map((server) => server.name),
      ...grantedRouteServers.map((server) => server.name),
      ...ctx.mountedMcpServers(agentEnv),
    ];
    const hostServers = ungatedHostServers(
      hostImportedMcpServerNames({
        operatorHome: ctx.options.config.operatorHome,
        agentKind: ctx.options.config.agentKind,
      }),
      mountedHostRoutes,
    );
    const clientOptions: ConstructorParameters<typeof AcpClient>[0] = {
      agentCommand: spawnCommand.command,
      harnessCommand: selectedCommand,
      agentArgs: spawnCommand.args,
      agentEnv,
      agentCwd: ctx.options.cwd,
      agentLabel: harnessLabel,
      // `bwrapPath` is set only when `detectBwrapSandbox` passed its self-test
      // (`config.ts`), which is exactly when `wrapAgentCommand` above wraps.
      osSandbox: Boolean(ctx.options.config.bwrapPath),
      autoApprovePermissions: false,
      permissionHandler: async (request) =>
        roomPermissionDecision(request, {
          mountedServers,
          hostServers,
          shellSandboxed: Boolean(ctx.options.config.bwrapPath),
          attachmentsDir: attachScratchRoot ? join(attachScratchRoot, 'attachments') : undefined,
          sandboxHome: homeOverlay.HOME,
        }),
      onUsage: (usage) => {
        void postChangedAgentUsage(ctx.options.api,ctx.agent.publicKey,usage)
          .catch(error => console.error('[agent-usage] publish failed', error));
      },
      onCommands: agentCommandCatalogPublisher({
        api: ctx.options.api,
        agentId: ctx.agent.publicKey,
        workspaceId: ctx.options.workspaceId,
      }),
    };
    ctx.client = (ctx.options.createAcpClient ?? ((value) => new AcpClient(value)))(
      clientOptions,
    );
    await startAgentProcess(ctx.client);
    startupStep('acp-initialize');
    if (assets) await markWorkspaceLayoutLive(assets);
    ctx.watchClaudeLogin();
    const persona = configuration.soul ?? self?.soul;
    const repositoryInfo =
      repositoryState.resolution === 'repository' && repositoryState.key
        ? {
            name: repositoryState.key,
            branch: repositoryState.targetBranch || 'main',
          }
        : undefined;
    // Whether this session runs shell commands is a fact about the harness AND
    // the sandbox: Codex executes them in its own read-only mode with no wrap at
    // all, while a harness that asks depends on the gate above. An unmeasured
    // harness states nothing (`roomShellCapability`).
    const session = assembleSessionPrompt({
      squireAvailable: Boolean(squireScope.relay),
      surface: directMessage ? 'dm' : 'room',
      agentName: self?.name ?? ctx.agent.name,
      machineHost: await machineHost(),
      ...(persona?.instructions
        ? { soul: { name: persona.name, instructions: persona.instructions } }
        : {}),
      agentCommand: command,
      ...(repositoryInfo ? { repository: repositoryInfo } : {}),
      // The permission handler approves home writes only under the same wrap.
      ...(ctx.options.config.bwrapPath && homeOverlay.HOME ? { writableHome: homeOverlay.HOME } : {}),
      ...(shellCapability === 'runs'
        ? { shell: { available: true } as const }
        : shellCapability === 'refused'
          ? {
              shell: {
                available: false,
                ...(ctx.options.config.shellUnavailableDetail
                  ? { detail: ctx.options.config.shellUnavailableDetail }
                  : {}),
              } as const,
            }
          : {}),
    });
    ctx.sessionSurface = directMessage ? 'dm' : 'room';
    ctx.turnInstructionPrefix = session.turnPrefix;
    ctx.sessionPromptSectionIds = session.report.map((section) => section.id);
    const conversationFingerprint = JSON.stringify([fingerprint, command,
      ctx.options.config.agentArgs, ctx.options.cwd, ctx.turnCheckout?.commit]);
    startupStep('session-prompt');
    const opened = await openAcpConversation({
      client: ctx.client,
      agentCommand: harnessLabel,
      resumeSessionId: ctx.warmTranscript.resumeSessionId(conversationFingerprint),
      cwd: ctx.options.cwd,
      mcpServers: sessionServers,
      mode: 'readonly',
      create: () => ctx.client!.sessionNew({
        cwd: ctx.options.cwd, mcpServers: sessionServers, mode: 'readonly', systemPrompt: session.systemPrompt,
      }),
      onResumeFailure: error => console.warn('[body] native conversation unavailable; starting cold:', error),
    });
    if (opened.kind === 'created') ctx.warmTranscript.forgetSession();
    startupStep('session-new');
    if (agentEnv.PI_CODING_AGENT_DIR) {
      const discovery = await readFile(join(agentEnv.PI_CODING_AGENT_DIR, 'beeline-mcp-startup.json'), 'utf8').catch(() => undefined);
      if (discovery) console.info('[body] session-tools', discovery);
    }
    ctx.warmTranscript.rememberSession(opened.sessionId, conversationFingerprint);
    ctx.sessionId = opened.sessionId;
    ctx.sessionContextPath = ctx.commandContext.path;
    ctx.sessionCwd = ctx.options.cwd;
    ctx.sessionCommit = ctx.turnCheckout?.commit;
    ctx.sessionGitHubToken = ctx.turnCheckout?.githubToken;
    ctx.sessionFingerprint = fingerprint;
    ctx.sessionCodegraphReady = codegraphReady;
    if (selection) {
      const options = filterAllowedModelConfigOptions(
        parseAdvertisedConfigOptions(opened.raw, selection.model),
      );
      const applied = await applyAgentModelSelection(ctx.client, opened.sessionId, options, selection);
      if (
        selection.model &&
        applied.appliedSelection.model &&
        applied.appliedSelection.model !== selection.model
      ) {
        recordSessionModelFallback(ctx.options.api, ctx.agent.publicKey, ctx.options.workspaceId,
          applied.appliedSelection, applied.options, `Room ${ctx.options.roomId}`);
      }
    }
    startupStep('model-selection');
    return opened.sessionId;
  }


  /**
   * The scheduler seam, and the only place that can see the boundary between
   * waiting for the previous turn and spawning a harness: `queue-wait` closes when
   * the process starts, and `cold` vs `warm` is decided by whether this
   * Room already holds a live ACP client.
   */
  export function monolithRoomTurnLoopLifecycle(ctx: MonolithRoomTurnLoop, trace?: TurnTrace): AgentProcessLifecycle {
    return {
      ...tracedAgentProcessLifecycle(() => ctx.activate(trace), () => ctx.sessionIsCurrent(), trace),
      stop: () => ctx.discardSession(true),
      isRunning: () => ctx.client?.isAlive === true,
      onWorkChanged: listener => {
        const client = ctx.client;
        client?.on('session/update', listener);
        client?.on('exit', listener);
        return () => { client?.off('session/update', listener); client?.off('exit', listener); };
      },
    };
  }


  /** The pinned providers a failure reason should name for this session. */
  export function monolithRoomTurnLoopServingProviders(ctx: MonolithRoomTurnLoop): string[] {
    return ctx.pinnedProviderOverride ? [ctx.pinnedProviderOverride] : ctx.pinnedProviders;
  }


  /** Why a turn carried no answer text, or undefined when it did. */
  export async function monolithRoomTurnLoopExplainEmpty(ctx: MonolithRoomTurnLoop, result: PromptResult): Promise<EmptyTurnExplanation | undefined> {
    if (['no-reply', 'repeated-tool-call'].includes(result.stopReason)) return undefined;
    if (durableReplyText(result.agentText)) return undefined;
    // Passive browser updates owe no answer and must not start provider
    // retries. Their receipt acknowledges delivery, even for a textless turn.
    if (ctx.commandContext.current?.source.systemEvent?.kind === 'computer-session-activity') return undefined;
    const explanation = await explainEmptyAgentTurn({
      agentLabel: harnessIdentityLabel({
        kind: ctx.options.config.agentKind,
        command: ctx.options.config.agentCommand ?? ctx.options.config.agentBinary,
      }),
      agentEnv: ctx.agentEnv,
      sessionId: ctx.sessionId!,
      result,
    });
    // OpenRouter refuses a key past its limit with 402; show the stop now.
    if (explanation.record?.kind === 'error' && explanation.record.status === 402)
      ctx.publishOpenRouterSpend(true);
    if (isSilentCompletion(result, explanation)) return undefined;
    // Private delivery answers the command without a chat reply. Only an
    // affirmative completed status counts; failed or unfinished calls still
    // owe an answer. Keep any durable text recovered from pi's turn record.
    if (result.toolCalls.some(isPrivateWorkToolCall) && !durableReplyText(explanation.recoveredText ?? '')) return undefined;
    return explanation;
  }


  /**
   * Re-pin the session to the next provider in the OpenRouter order and open a
   * fresh session on it, so the retry of an empty completion or a failing
   * provider is served — and named — by exactly one provider. Undefined when
   * the pin has nowhere left to go.
   */
  export async function monolithRoomTurnLoopRepinNextProvider(ctx: MonolithRoomTurnLoop, trace?: TurnTrace, reason?: string): Promise<string | undefined> {
    const next = nextPinnedProvider(ctx.pinnedProviders, ctx.pinnedProviderOverride);
    if (!next) return undefined;
    // The retry is its own timeline: everything from here — the fresh ACP
    // handshake included — belongs to attempt two, never to attempt one's
    // first-token time.
    trace?.retry({ provider: next, ...(reason ? { reason } : {}) });
    const client = ctx.client;
    ctx.stopClaudeLoginWatch();
    ctx.client = undefined;
    ctx.sessionId = undefined;
    ctx.sessionContextPath = undefined;
    ctx.sessionFingerprint = undefined;
    ctx.sessionCodegraphReady = false;
    if (client) await stopAgentProcess(client);
    ctx.pinnedProviderOverride = next;
    await (trace ? trace.measure('activation', () => ctx.activate(trace)) : ctx.activate());
    return next;
  }


  export function monolithRoomTurnLoopStartPrompt(ctx: MonolithRoomTurnLoop, item: HumanMessage): void {
    const active: ActiveTurn = {
      item,
      steers: [],
      steerTail: Promise.resolve(),
      resumeRequested: false,
      cancelled: false,
      phase: 'prompting',
      promise: Promise.resolve(),
    };
    ctx.activeTurn = active;
    active.promise = ctx.prompt(active)
      .catch((error) => {
        console.error(`[thin-core] monolith Room ${ctx.options.roomId} turn failed:`, turnErrorDetail(error));
      })
      .finally(() => {
        if (ctx.activeTurn === active) {
          ctx.activeTurn = undefined;
          ctx.wakeIntake?.();
        }
      });
  }


  /**
   * Obey a stop the requester already made a fact.
   *
   * A stop names ONE request id and touches only the turn that answers it. The
   * turn in flight is cancelled at the harness and marked so its own run
   * publishes nothing; a turn still queued is simply dropped, since starting
   * work the person has already withdrawn is worse than never starting it.
   * A stop for neither is ignored — it belongs to a turn that ended between
   * the press and the delivery, and the server's own receipt already said so.
   */
  export function monolithRoomTurnLoopStopTurn(ctx: MonolithRoomTurnLoop, requestId: string): void {
    if (ctx.pausedOnGrantRequestId === requestId) {
      ctx.pausedOnGrantRequestId = undefined;
      ctx.pausedOnGrantKind = undefined;
    }
    ctx.squireRelay.cancel(requestId);
    for (let index = ctx.queuedTurns.length - 1; index >= 0; index -= 1)
      if (ctx.queuedTurns[index]!.id === requestId) ctx.queuedTurns.splice(index, 1);
    const active = ctx.activeTurn;
    if (!active || active.item.id !== requestId) return;
    active.cancelled = true;
    // Cancellation ends the process tree, including MCP keepalives. A harness
    // notification alone leaves tools running under the revoked generation.
    void ctx.options.scheduler.stop(ctx.options.roomId, true).catch(error =>
      console.error('[body] cancelled Room process cleanup failed:', error));
  }
