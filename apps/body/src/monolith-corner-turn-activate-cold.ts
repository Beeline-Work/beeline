import { postChangedAgentUsage } from './helper-usage-binding.js';
import { agentBehavior } from './agent-command.js';
import type { SandboxSessionSpec } from './bwrap-sandbox.js';
import { extraDependencyRoots, dependencyFingerprint, prepareDependencyGeneration, installDependencyNpmGuard, dependencyRequest } from './dependency-generation.js';
import { CODE_OWNED_HOST_MCP_NAMES } from './mcp-route-class.js';
import { roomPermissionDecision } from './monolith-room-turn.js';
import { modelContextWindowTokens } from './model-context-window.js';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { machineHost } from './machine-host.js';
import { prepareCodexCacheTargets, preparePackageCacheTargets, preparePrivateAssets, markWorkspaceLayoutLive, prepareWorkspaceAssets, workspaceAssetPaths, workspaceCacheEnv } from './workspace-assets.js';
import { admitSharedAssets } from './shared-asset-capacity.js';
import { AcpClient, openAcpConversation, type McpServerWire } from './acp.js';
import { AGENT_SKILL_DIRS, expectedMountedImportedMcpServerNames, grantedSquireHostBindPaths, harnessStateDirsFromEnv, hostImportedMcpDeclarations, hostImportedMcpServerNames, prepareRoomAgentHome } from './agent-home.js';
import { grantedHostRouteWires, grantedSquireHostRoute, ungatedHostServers } from './host-mcp-route.js';
import { openRouterRoutingInput } from './openrouter-routing.js';
import { agentOpenRouterKey } from './openrouter-key-usage.js';
import { agentCommandCatalogPublisher } from './agent-command-catalog.js';
import { sessionConfigFingerprint } from './session-config-fingerprint.js';
import { hasCornerPrepareScript } from './corner-prepare-script.js';
import { registryMcpHostBindPaths, registryMcpHostDeclarations } from './registry-mcp.js';
import { installPiMcpBridge } from './pi-mcp-bridge.js';
import { installPiTurnBudget } from './pi-turn-budget.js';
import { beelineAgentMcpServer, readOnlyMcpServer, writeSessionResourceAuth, recordSessionModelFallback, tracedAgentProcessLifecycle } from './room-session.js';
import { codegraphFingerprintServers, codegraphMcpServer, prepareCodegraphIndex } from './codegraph.js';
import { credentialMaskPaths, harnessHomeStateDirs, siblingAgentMaskPaths, wrapAgentCommand } from './bwrap-sandbox.js';
import { harnessIdentityLabel, sessionNewMcpServers } from './cursor-acp-bridge.js';
import { bodyAgentCommand } from './config.js';
import { agentArgsWithModelSelection, applyAgentModelSelection, filterAllowedModelConfigOptions, parseAdvertisedConfigOptions } from './model-config.js';
import { runtimeDirectory } from './runtime.js';
import { assembleSessionPrompt, cornerHasRepositoryWork, CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION, cornerReviewerInstruction } from './prompt-assembly.js';
import { startAgentProcess, type AgentProcessLifecycle } from './agent-process.js';
import { harnessEnforcement } from './harness-capabilities.js';
import { TurnTrace } from './turn-trace.js';
import { installCornerGitHubWrappers } from './corner-github-auth.js';
import { agentGitIdentityEnv } from './agent-git-identity.js';
import { mobileNodeModulesStoreDir, sharedNpmCacheDir, sharedPnpmStoreDir, sharedTurboCacheDir, warmNodeModulesStoreDir } from './warm-node-modules.js';
import { MonolithCornerTurnLoop, execFileAsync } from './monolith-corner-turn.js';



  export async function monolithCornerTurnLoopActivateCold(ctx: MonolithCornerTurnLoop, trace?: TurnTrace): Promise<string> {
    trace?.noteActivation('cold');
    ctx.sectionBaseline.reset();
    const [configuration, roster, grants, restored] = await Promise.all([
      ctx.configuration(),
      ctx.roster(),
      ctx.grantedResources(),
      ctx.restoredState(),
    ]);
    const { hostRoutes: grantedHostRoutes, devices: grantedDevices, isolatedCategories } = grants;
    const privateAssetRoot = resolve(runtimeDirectory(ctx.options.runtime.supervisorRoot,
      ctx.options.runtime.agent.publicKey), 'private-assets');
    const self = roster.members.find((member) => member.identityId === ctx.agent.publicKey);
    const opener = ctx.options.openedBy
      ? roster.members.find((member) => member.identityId === ctx.options.openedBy)
      : undefined;
    // The reviewer post is the one fixed role. Who opened the corner, and who
    // writes its code, never pick the prompt: the implementer rules are
    // conditional and the agent decides whether it was told to write code.
    const reviewer = Boolean(ctx.options.repository) && configuration.isReviewer === true;
    ctx.reviewerInstructionInput = reviewer
      ? {
          isReviewer: true,
          ...(opener?.handle && opener.identityId !== ctx.agent.publicKey
            ? { authorHandle: opener.handle }
            : {}),
        }
      : undefined;
    ctx.sessionSurface = ctx.options.repository ? 'code-corner' : 'repo-less-corner';
    ctx.repositoryWork = cornerHasRepositoryWork(restored.brief);
    const cornerPrepareScript = await hasCornerPrepareScript(ctx.options.worktreePath);
    ctx.sessionPromptContext = {
      brief: restored.brief,
      surface: ctx.sessionSurface,
      agentName: self?.name ?? ctx.agent.name,
      ...(configuration.reviewerHandle ? { reviewerHandle: configuration.reviewerHandle } : {}),
      reviewer,
      cornerPrepareScript,
    };
    await mkdir(ctx.options.worktreePath, { recursive: true });
    const selection = {
      model: configuration.model ?? ctx.options.config.modelSelection?.model,
      effort: configuration.effort ?? ctx.options.config.modelSelection?.effort,
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
      roomId: ctx.options.cornerId,
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
          isReviewer: reviewer,
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
              if (!ctx.pinnedProviderOverride) ctx.pinnedProviders = [...routing.providers];
              // See `MonolithRoomTurnLoop.acceptsImages` (C87).
              ctx.modelTakesImages = routing.input ? routing.input.includes('image') : undefined;
            },
          }),
        })
      : {};
    const command = bodyAgentCommand(ctx.options.config);
    const harnessLabel = harnessIdentityLabel({
      kind: ctx.options.config.agentKind,
      command,
    });
    const repository = ctx.options.repository;
    let githubEnv: Record<string, string> = repository
      ? { GH_TOKEN: repository.githubToken, GITHUB_TOKEN: repository.githubToken }
      : {};
    if (repository && ctx.options.config.runtimeConfigPath && ctx.options.config.agentHomeRoot) {
      const gitBinary = (await execFileAsync('which', ['git'])).stdout.trim();
      const ghBinary = await execFileAsync('which', ['gh'])
        .then((result) => result.stdout.trim())
        .catch(() => undefined);
      // The push guard is scoped to the worktree's OWN `origin`; this is the
      // URL the corner actually pushes to, not a re-derivation of the server
      // fact (which would miss a `git://` remote mapped to GitHub HTTPS).
      const originUrl = await execFileAsync(gitBinary, [
        '-C',
        ctx.options.worktreePath,
        'remote',
        'get-url',
        'origin',
      ])
        .then((result) => result.stdout.trim() || undefined)
        .catch(() => undefined);
      const launchers = await installCornerGitHubWrappers({
        root: ctx.options.config.agentHomeRoot,
        runtimeConfigPath: ctx.options.config.runtimeConfigPath,
        roomId: ctx.options.parentRoomId,
        cliEntrypoint: process.argv[1]!,
        gitBinary,
        featureBranch: repository.featureBranch,
        targetBranch: repository.targetBranch,
        ...(originUrl ? { originUrl } : {}),
        ...(ghBinary ? { ghBinary } : {}),
        inheritedPath: homeOverlay.PATH ?? ctx.options.config.agentEnv.PATH ?? process.env.PATH,
      });
      githubEnv = launchers.env;
      ctx.cornerGitHubCli = launchers.githubCli;
    }
    const assets = ctx.options.config.agentSharedAssetRoot && ctx.options.config.bwrapPath && homeOverlay.HOME &&
      await admitSharedAssets(ctx.options.runtime.supervisorRoot, 1024 ** 3)
      ? await prepareWorkspaceAssets(ctx.options.config.agentSharedAssetRoot)
      : undefined;
    if (isolatedCategories.length)
      await preparePrivateAssets(privateAssetRoot, isolatedCategories);

    const cacheEnv = assets
      ? workspaceCacheEnv(assets, ctx.options.worktreePath,
          isolatedCategories.includes('package-cache') ? privateAssetRoot : undefined)
      : isolatedCategories.includes('package-cache')
        ? workspaceCacheEnv(workspaceAssetPaths(privateAssetRoot), ctx.options.worktreePath, privateAssetRoot)
        : {};
    if (assets && agentBehavior(ctx.options.config.agentKind).codexCacheBindings && homeOverlay.CODEX_HOME)
      await prepareCodexCacheTargets(homeOverlay.CODEX_HOME);
    if (assets && homeOverlay.HOME) await preparePackageCacheTargets(homeOverlay.HOME);
    // A build output belongs to this corner, even when its package downloads
    // come from the Workspace cache.
    const cargoTargetDir = resolve(ctx.options.repository?.readOnly ? ctx.options.config.agentHomeRoot ?? operatorHome : ctx.options.worktreePath, '.beeline-cargo-target');
    const npmCacheDir = cacheEnv.npm_config_cache ?? sharedNpmCacheDir(ctx.options.runtime.supervisorRoot);
    const pnpmStoreDir = cacheEnv.PNPM_CONFIG_STORE_DIR ?? sharedPnpmStoreDir(ctx.options.runtime.supervisorRoot);
    // Turbo derives its cache directory from the repository's GIT COMMON
    // directory; in a linked corner worktree that is the read-only
    // `repositories/.turbo/cache`, so every `turbo run` fails before it starts.
    const turboCacheDir = cacheEnv.TURBO_CACHE_DIR ?? sharedTurboCacheDir(ctx.options.runtime.supervisorRoot);
    const modelCacheDir = cacheEnv.HF_HUB_CACHE ?? resolve(ctx.options.runtime.supervisorRoot, 'beeline', 'model-cache');
    const hfHomeDir = assets && ctx.options.config.agentHomeRoot
      ? resolve(ctx.options.config.agentHomeRoot, 'cache/huggingface-private')
      : modelCacheDir;
    await Promise.all(
      [npmCacheDir, pnpmStoreDir, cargoTargetDir, turboCacheDir, modelCacheDir].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    );
    const agentEnv: Record<string, string> = {
      ...ctx.options.config.agentEnv,
      ...homeOverlay,
      ...githubEnv,
      // Git reads these before any config, so this session commits as itself
      // no matter which session last prepared the shared corner worktree.
      ...agentGitIdentityEnv(ctx.agent),
      ...cacheEnv,
      BEELINE_TURN_CONTEXT_FILE: ctx.commandContext.path,
      npm_config_cache: npmCacheDir,
      // pnpm reads its settings from PNPM_CONFIG_* environment variables and
      // hardlinks packages out of this content-addressable store.
      PNPM_CONFIG_STORE_DIR: pnpmStoreDir,
      CARGO_TARGET_DIR: cargoTargetDir,
      TURBO_CACHE_DIR: turboCacheDir,
      HF_HOME: hfHomeDir,
      HUGGINGFACE_HUB_CACHE: assets || isolatedCategories.includes('package-cache')
        ? modelCacheDir : join(modelCacheDir, 'hub'),
    };

    await mkdir(hfHomeDir, { recursive: true, mode: 0o700 });
    ctx.agentEnv = agentEnv;
    const selectedCommand = command;
    if (assets && ctx.options.config.agentPrivateRoot)
      await mkdir(ctx.options.config.agentPrivateRoot, { recursive: true, mode: 0o700 });
    ctx.modelContextTokens = await modelContextWindowTokens(
      selection.model, agentEnv.PI_CODING_AGENT_DIR,
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
    const homeStateDirs = harnessHomeStateDirs(harnessLabel, agentEnv.HOME ?? operatorHome);
    await Promise.all(homeStateDirs.map((dir) => mkdir(dir, { recursive: true })));
    // The same path handed to the MCP server as BEELINE_ATTACH_SCRATCH_ROOT
    // (below): post_artifact can only post what write_scratch_file could write,
    // so the sandbox must leave this writable too. It sits under the
    // protected supervisorRoot above, so it needs its own re-bind.
    const attachScratchRoot = ctx.options.config.agentHomeRoot ?? tmpDir;
    if (attachScratchRoot) await mkdir(attachScratchRoot, { recursive: true });
    const dependencyPaths: string[] = [];
    const sandboxSpec: SandboxSessionSpec = {
        mode: ctx.options.repository?.readOnly ? 'readonly' : 'edit',
        cwd: ctx.options.worktreePath,
        worktreePath: ctx.options.worktreePath,
        ...(repository ? { gitCommonDir: repository.gitCommonDir } : {}),
        protectedPaths: [ctx.options.runtime.supervisorRoot],
        dependencyPaths,
        harnessStateDirs: stateDirs,
        harnessHomeStateDirs: homeStateDirs,
        ...(tmpDir ? { tmpDir } : {}),
        additionalWritablePaths: [
          ...(ctx.options.config.browserShareHostSocket ? [dirname(ctx.options.config.browserShareHostSocket)] : []),
          ...(attachScratchRoot ? [attachScratchRoot] : []),
          ...(assets ? [] : [npmCacheDir, pnpmStoreDir, turboCacheDir, modelCacheDir]),
          cargoTargetDir,
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
    if (!ctx.options.config.bwrapPath && ['', 'apps/mobile'].some(part =>
      existsSync(resolve(ctx.options.worktreePath, part, 'node_modules/.beeline-generation')))) {
      throw new Error('Beeline shared dependencies require a working bubblewrap sandbox. Restore sandbox support before resuming this checkout.');
    }
    if (repository && !repository.readOnly && ctx.options.config.bwrapPath && (ctx.repositoryWork || existsSync(resolve(ctx.options.worktreePath, 'node_modules')))) {
      const npm = (await execFileAsync('which', ['npm'])).stdout.trim();
      const install = (cwd: string) => async () => {
        const command = wrapAgentCommand({ bwrapPath: ctx.options.config.bwrapPath,
          spec: { ...sandboxSpec, cwd }, command: npm, args: ['ci', '--no-audit', '--no-fund'] });
        await execFileAsync(command.command, command.args, {
          cwd, env: { ...process.env, ...agentEnv }, maxBuffer: 16 * 1024 * 1024,
        });
      };
      dependencyPaths.push(...await prepareDependencyGeneration({
        root: ctx.options.worktreePath, store: warmNodeModulesStoreDir(ctx.options.runtime.supervisorRoot), npm, cache: npmCacheDir, install: install(ctx.options.worktreePath),
      }));
      const mobile = resolve(ctx.options.worktreePath, 'apps/mobile');
      if (existsSync(resolve(mobile, 'node_modules')) || existsSync(resolve(ctx.options.worktreePath, dependencyRequest))) dependencyPaths.push(...await prepareDependencyGeneration({
        root: mobile, store: mobileNodeModulesStoreDir(ctx.options.runtime.supervisorRoot), npm, cache: npmCacheDir, install: install(mobile),
      }));
      for (const extra of await extraDependencyRoots(ctx.options.worktreePath, ctx.options.config.agentHomeRoot)) {
        dependencyPaths.push(...await prepareDependencyGeneration({
          root: extra, store: warmNodeModulesStoreDir(ctx.options.runtime.supervisorRoot),
          npm, cache: npmCacheDir, install: install(extra),
        }));
      }
      if (dependencyPaths.length && ctx.options.config.agentHomeRoot) {
        agentEnv.PATH = await installDependencyNpmGuard(ctx.options.config.agentHomeRoot, npm, agentEnv.PATH ?? process.env.PATH ?? '', dependencyPaths);
        agentEnv.BEELINE_READONLY_DEPENDENCIES = '1';
      }
    }

    const spawnCommand = wrapAgentCommand({
      bwrapPath: ctx.options.config.bwrapPath,
      spec: sandboxSpec,
      command: selectedCommand,
      args: agentArgs,
    });
    const hostDeclarations = hostImportedMcpDeclarations({
      operatorHome,
      agentKind: ctx.options.config.agentKind,
    });
    let mountedServers: string[] = [];
    const hostServers = ungatedHostServers(
      [...CODE_OWNED_HOST_MCP_NAMES, ...hostImportedMcpServerNames({ operatorHome, agentKind: ctx.options.config.agentKind })],
      mountedHostRoutes,
    );
    const clientOptions: ConstructorParameters<typeof AcpClient>[0] = {
      agentCommand: spawnCommand.command,
      harnessCommand: selectedCommand,
      agentArgs: spawnCommand.args,
      agentEnv,
      agentCwd: ctx.options.worktreePath,
      agentLabel: harnessLabel,
      backgroundTasks: true,
      autoApprovePermissions: !repository?.readOnly,
      ...(repository?.readOnly ? { osSandbox: Boolean(ctx.options.config.bwrapPath) } : {}),
      permissionHandler: async request => repository?.readOnly
        ? roomPermissionDecision(request, { mountedServers, hostServers, shellSandboxed: Boolean(ctx.options.config.bwrapPath), sandboxHome: homeOverlay.HOME })
        : 'allow',
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
    if (assets) await markWorkspaceLayoutLive(assets);
    ctx.watchClaudeLogin();
    const codegraphReady = await prepareCodegraphIndex(
      ctx.options.config,
      ctx.options.worktreePath,
    );
    const fingerprint = sessionConfigFingerprint({
      dependencyGeneration: await dependencyFingerprint(ctx.options.worktreePath, ctx.options.config.agentHomeRoot),
      devices: grantedDevices,
      isolatedCategories,
      model: configuration.model ?? ctx.options.config.modelSelection?.model,
      effort: configuration.effort ?? ctx.options.config.modelSelection?.effort,
      fastMode: configuration.fastMode,
      soul: configuration.soul ?? self?.soul,
      agentName: self?.name ?? ctx.agent.name,
      yoloMode: configuration.yoloMode,
      repositoryWork: cornerHasRepositoryWork(restored.brief),
      cornerPrepareScript,
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
      reviewerHandle: configuration.reviewerHandle,
    });
    const nativeIoProven = harnessEnforcement(harnessLabel).enforcement !== 'unknown';
    const servers: McpServerWire[] = [
      ...(nativeIoProven ? [] : [readOnlyMcpServer(ctx.options.config, ctx.options.worktreePath)]),
      ...(repository
        ? [
            {
              name: 'buzz-dev-mcp',
              command: ctx.options.config.mcpBinary,
              args: [],
              // ACP hosts launch stdio MCP servers with an explicit, sanitized env.
              // This token is minted for this exact corner and is also the credential
              // helper's password source, so its shell commands need the same scope as
              // the corner harness without inheriting any host credentials.
              env: [
                { name: 'GH_TOKEN', value: repository.githubToken },
                { name: 'GITHUB_TOKEN', value: repository.githubToken },
                // Its shell tool runs the same installs the harness does, and
                // a sanitized env would otherwise send them to npm's default
                // per-corner cache.
                { name: 'npm_config_cache', value: npmCacheDir },
                { name: 'PNPM_CONFIG_STORE_DIR', value: pnpmStoreDir },
                { name: 'CARGO_TARGET_DIR', value: cargoTargetDir },
                { name: 'HF_HOME', value: hfHomeDir },
                { name: 'HUGGINGFACE_HUB_CACHE', value: assets || isolatedCategories.includes('package-cache')
                  ? modelCacheDir : join(modelCacheDir, 'hub') },
              ],
            },
          ]
        : []),
      beelineAgentMcpServer(ctx.options.config, ctx.options.api, {
        roomId: ctx.options.parentRoomId,
        workspaceId: ctx.options.workspaceId,
        cornerId: ctx.options.cornerId,
        reviewer,
        nativeIoProven,
        agentCommand: harnessLabel,
        repositoryBacked: Boolean(repository),
        attachRoot: ctx.options.worktreePath,
        // The whole per-session overlay, not an enumerated subset: see
        // `monolith-room-turn.ts`'s matching comment.
        attachScratchRoot,
        ...(!repository ? { cornerScratchRoot: ctx.options.worktreePath } : {}),
        turnContextPath: ctx.commandContext.path,
        squireRelay: squireScope.relay,
        ...(ctx.options.grantRunnerEndpoint
          ? { grantRunner: ctx.options.grantRunnerEndpoint }
          : {}),
      }),
    ];
    if (codegraphReady) {
      const codegraph = codegraphMcpServer(ctx.options.config, ctx.options.worktreePath, {
        readonly: Boolean(repository?.readOnly),
      });
      if (codegraph) servers.push(codegraph);
    }
    const grantedRouteServers = grantedHostRouteWires(
      mountedHostRoutes,
      operatorHome,
      { ...hostDeclarations, ...registryHostDeclarations },
      resourceAuthFile,
      squireScope,
    );
    const sessionServers = sessionNewMcpServers<McpServerWire>(harnessLabel, servers, grantedRouteServers);
    mountedServers = [...servers, ...grantedRouteServers].map(server => server.name);
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
    const persona = configuration.soul ?? self?.soul;
    const session = assembleSessionPrompt({
      squireAvailable: Boolean(squireScope.relay),
      ...ctx.sessionPromptContext!,
      machineHost: await machineHost(),
      githubCli: ctx.cornerGitHubCli,
      ...(persona?.instructions
        ? { soul: { name: persona.name, instructions: persona.instructions } }
        : {}),
      agentCommand: command,
      ...(repository
        ? {
            worktree: {
              featureBranch: repository.featureBranch,
              targetBranch: repository.targetBranch,
            },
          }
        : {}),
    });
    ctx.turnSessionPrefix = session.turnPrefix;
    ctx.sessionPromptSectionIds = session.report.map((section) => section.id);
    const conversationFingerprint = JSON.stringify([fingerprint, command,
      ctx.options.config.agentArgs, ctx.options.worktreePath]);
    const opened = await openAcpConversation({
      client: ctx.client,
      agentCommand: harnessLabel,
      resumeSessionId: ctx.warmTranscript.resumeSessionId(conversationFingerprint),
      cwd: ctx.options.worktreePath,
      mcpServers: sessionServers,
      mode: repository?.readOnly ? 'readonly' : 'edit',
      create: () => ctx.client!.sessionNew({
        cwd: ctx.options.worktreePath, mcpServers: sessionServers, mode: repository?.readOnly ? 'readonly' : 'edit', systemPrompt: session.systemPrompt,
      }),
      onResumeFailure: error => console.warn('[body] native conversation unavailable; starting cold:', error),
    });
    if (opened.kind === 'created') ctx.warmTranscript.forgetSession();
    ctx.warmTranscript.rememberSession(opened.sessionId, conversationFingerprint);
    ctx.sessionId = opened.sessionId;
    ctx.sessionContextPath = ctx.commandContext.path;
    ctx.sessionFingerprint = fingerprint;
    ctx.sessionCodegraphReady = codegraphReady;
    let appliedModel: string | undefined;
    if (selection) {
      const options = filterAllowedModelConfigOptions(
        parseAdvertisedConfigOptions(opened.raw, selection.model),
      );
      const applied = await applyAgentModelSelection(ctx.client, opened.sessionId, options, selection);
      appliedModel = applied.appliedSelection.model;
      if (selection.model && appliedModel && appliedModel !== selection.model) {
        recordSessionModelFallback(ctx.options.api, ctx.agent.publicKey, ctx.options.workspaceId,
          applied.appliedSelection, applied.options, `corner ${ctx.options.cornerId}`);
      }
    }
    ctx.sessionModel = appliedModel ?? selection?.model ?? null;
    return opened.sessionId;
  }


  /**
   * Resolve the review target at prompt time, not session activation time.
   *
   * A push can land after a reviewer session starts but before its first
   * prompt, or while that prompt is running. The active prompt and its bounded
   * second pass therefore each read the current green lifecycle head. The
   * server still compares approve_merge's SHA with the current head, so a push
   * after this read fails closed too.
   */
  export async function monolithCornerTurnLoopActiveReviewerInstruction(ctx: MonolithCornerTurnLoop, refreshChecks = true): Promise<string | undefined> {
    const input = ctx.reviewerInstructionInput;
    if (!input) return undefined;
    try {
      const [restore, localHead] = await Promise.all([
        ctx.options.api.execute('getCornerRestoreState', {
          cornerId: ctx.options.cornerId,
        }),
        execFileAsync('git', ['-C', ctx.options.worktreePath, 'rev-parse', 'HEAD']).then(
          ({ stdout }) => stdout.trim(),
        ),
      ]);
      const pr = restore.lifecycle?.pr;
      if (!pr?.number) return CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION;
      // One provider refresh per wake. The bounded second pass reads the
      // committed lifecycle, including any head/check changes since that read.
      const liveChecks = refreshChecks
        ? await ctx.options.api.execute('getPrChecksStatus', {
            cornerId: ctx.options.cornerId, pullRequest: pr.number,
          })
        : { checks: restore.lifecycle?.checks === 'passing' ? 'passed' : 'pending',
            headSha: pr.headSha, stage: restore.lifecycle?.lifecycle === 'done' ? 'merged' : 'checking' };
      if (
        liveChecks.checks !== 'passed' ||
        liveChecks.stage === 'merged' || liveChecks.stage === 'closed' ||
        !pr.headSha || liveChecks.headSha !== pr.headSha ||
        pr.headSha !== localHead
      )
        return CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION;
      return [
        'Current stable reviewer target for this active turn; it supersedes any older head in the trigger or transcript:',
        cornerReviewerInstruction({
          ...input,
          pullRequestNumber: pr.number,
          headSha: pr.headSha,
          briefRevision: restore.brief?.revision,
        }),
        ...(ctx.options.config.agentHomeRoot &&
        ctx.options.config.agentKind &&
        !(AGENT_SKILL_DIRS as readonly string[]).includes(ctx.options.config.agentKind)
          ? [
              `This harness has no verified native skill discovery. Read the release-managed review procedure at ${resolve(ctx.options.config.agentHomeRoot, 'codex', 'skills', 'beeline-review', 'SKILL.md')} before the verdict.`,
            ]
          : []),
      ].join('\n');
    } catch {
      return CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION;
    }
  }


  /** Queue timing ends when this conversation starts or reuses its process. */
  export function monolithCornerTurnLoopLifecycle(ctx: MonolithCornerTurnLoop, trace?: TurnTrace): AgentProcessLifecycle {
    return {
      ...tracedAgentProcessLifecycle(() => ctx.activate(trace), () => ctx.sessionIsCurrent(), trace),
      hasBackgroundWork: () => Boolean(ctx.client?.hasBackgroundTools || ctx.retiredClients.size),
      stop: async (force = false) => {
        if (force) await Promise.all([...ctx.retiredClients.values()].map(retired => {
          retired.stop();
          return retired.done;
        }));
        await ctx.discardSession(true, force);
      },
      isRunning: () => Boolean(ctx.client?.isAlive || ctx.retiredClients.size),
      onWorkChanged: listener => {
        const client = ctx.client;
        client?.on('session/update', listener);
        client?.on('exit', listener);
        return () => { client?.off('session/update', listener); client?.off('exit', listener); };
      },
    };
  }
