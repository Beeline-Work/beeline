# Harness, settings and parallel-path sweep

Audited against the task base `cda3aa4aa` on 2026-11-02. Counts use the existing guard unchanged, including matches inside comments and generated strings. These are the lowest totals justified by checked-in callers and deployment inputs in this sweep; no production data or operator homes were inspected.

## Result

| Rule | Before | After |
| --- | ---: | ---: |
| agents.server-harness-branch | 3 | 0 |
| agents.helper-harness-branch | 85 | 0 |
| settings.server-env | 62 | 60 |
| settings.helper-env | 56 | 55 |
| settings.phone-env | 13 | 11 |
| settings.shared-env | 0 | 0 |
| paths.server-parallel | 21 | 21 |
| paths.helper-parallel | 30 | 29 |
| paths.phone-parallel | 21 | 19 |
| paths.shared-parallel | 5 | 5 |

## Removed and centralized

- Every guarded helper harness-name comparison now reads the typed `Record<AgentKind, AgentBehavior>` beside `AGENT_KINDS` in `apps/body/src/agent-command.ts`. Credential and joined-session policy tables live there too. MCP discovery preserves source precedence and isolated/ambient roots. Joined app discovery preserves name precedence and hook output formats.
- The shared sign-in card contract owns `AGENT_SIGN_IN_KINDS`, consumed by the helper’s paste-code dispatch and shared key-card classifier; the server does not choose execution behavior.
- `PHONE_GITHUB_EXCHANGE_ENDPOINT`: retired cutover override with no production caller. Ticket consumption now always uses mounted auth; development-only local identities retain their existing check.
- `BACKGROUND_RECONCILIATION_MS`: undeployed generic cadence override removed; the existing 60-second cadence and due-time job scheduling remain.
- `BEELINE_BODY_MAX_SESSIONS_FLOOR`: undeployed floor override removed; `SessionScheduler` already owns the same default of four. The operator ceiling and per-Room budgeting remain.
- `EXPO_PUBLIC_POSTHOG_KEY`: unused alternate spelling removed. `app.config.js` supplies the provider key from `EXPO_PUBLIC_POSTHOG_API_KEY` through the manifest.
- `EXPO_PUBLIC_BEELINE_RELEASE_VERSION` in the runtime reader: duplicate manifest override removed; `app.config.js` embeds the same build input in both binary and OTA manifests.
- `buzz-readonly-mcp` executable fallback: no current package installs that binary; all supported bundle, configured binary/script, and source launch paths remain.
- The old GitHub installation return component and its rollout wrapper are removed. The serving server unconditionally reports repository onboarding enabled; the current refresh/recovery component is the only installation return.

## Settings retained

These lists cover direct `process.env.NAME` matches counted by the existing ratchet; no access was rewritten to evade it. Parameterized environment contracts retain their existing behavior.

### Server (60)

| Retained names | Why |
| --- | --- |
| `NODE_ENV`, `HOST`, `PORT`, `PUBLIC_ORIGIN`, `BEELINE_MONOLITH_BASE_URL`, `BEELINE_COMPUTER_ORIGIN`, `BEELINE_WEB_APP_ORIGINS` | Listener, public URLs and web origins remain deployment inputs; local development and production have different origins. |
| `MIGRATION_DATABASE_URL`, `DATABASE_URL`, `DATABASE_LISTENER_URL`, `BEELINE_SERVER_MACHINES`, `DATABASE_POOL_MAX` | Separate database roles/listener and per-machine connection budgets cannot be inferred safely from one connection string. |
| `BEELINE_RETIRE_WELCOME_GREETER_ID` | Explicit release-owner authority for the Welcome retirement; must not become an automatic destructive migration. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET` | GitHub App/OAuth identity and signed webhook credentials. |
| `COINBASE_CDP_API_KEY_ID`, `COINBASE_CDP_API_KEY_SECRET`, `COINBASE_CDP_WALLET_SECRET`, `COINBASE_CDP_WEBHOOK_SECRETS` | Wallet custody and webhook verification secrets. |
| `BEELINE_LINK_CLIENT_ID`, `BEELINE_LINK_CLIENT_SECRET`, `BEELINE_LINK_PUBLISHABLE_KEY`, `BEELINE_LINK_TOKEN_KEY` | Distinct Link client, public and encryption credentials. |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Push sender credential; absence intentionally disables sending. |
| `MEDIA_MAX_BYTES` | Shared upload/media limit used by storage and daemon validation. |
| `BEELINE_COMPOSIO_API_KEY`, `BEELINE_MCP_WEBHOOK_KEY` | App provider credential and webhook verification key. |
| `BEELINE_REVIEW_SECRET`, `BEELINE_RELEASE_NOTIFY_SECRET`, `BEELINE_DASHBOARD_SECRET`, `BEELINE_SENTRY_CLIENT_SECRET` | Existing privileged review, release receipt, dashboard and error ingestion boundaries. |
| `FLY_MACHINE_ID`, `FLY_FREE_AGENT_API_TOKEN`, `FLY_FREE_AGENT_APP`, `FLY_FREE_AGENT_API_ORIGIN` | Actual Machine identity and provisioner target/credential; configurable API origin supports isolated provider testing. |
| `BEELINE_FREE_AGENT_MODEL_KEY`, `BEELINE_FREE_AGENT_MODEL_UPSTREAM` | Hosted model proxy credential and upstream model; not the agent harness kind. |
| `BEELINE_NEXT_DAY_CHECKIN`, `BEELINE_EMAIL_API_KEY`, `BEELINE_EMAIL_FROM` | Existing operational check-in stop switch fences in-flight replies; email sender and credential are external configuration. |
| `BEELINE_MIN_HELPER_VERSION`, `BEELINE_RELEASE_VERSION`, `BEELINE_DASHBOARD_LATEST_MOBILE_RELEASE`, `BEELINE_DASHBOARD_MIN_RUNTIME_IOS`, `BEELINE_DASHBOARD_MIN_RUNTIME_ANDROID` | Supported installed versions/store runtimes can differ from the running server version. |
| `BEELINE_RELEASE_SHA`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `FLY_IMAGE_REF`, `LIVE_PAINT_DIAGNOSTICS` | Release provenance, optional Sentry destination/environment and opt-in paint diagnostics. |
| `BEELINE_X_AD_ACCOUNT_ID`, `BEELINE_X_SIGNUP_EVENT_ID`, `BEELINE_X_PIXEL_TOKEN`, `CLOUDFLARE_ANALYTICS_TOKEN` | External advertising account/event identifiers and analytics credentials. |
| `VITEST`, `SERVER_COVERAGE_MAP_DIR` | Test isolation and CI coverage output; neither is a live feature rollout. |

### Helper (55)

| Retained names | Why |
| --- | --- |
| `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, `PATH`, `HOME`, `TMPDIR`, `USER`, `ANDROID_HOME`, `NODE_OPTIONS` | Host user/session paths and inherited toolchain configuration; required for native scopes, isolated homes and Android tooling. |
| `BEELINE_MANAGED_BY_SYSTEMD`, `BEELINE_INTERNAL_UPDATE_WORKER`, `BEELINE_INTERNAL_RECOVERY`, `BEELINE_LAB`, `BEELINE_RECOVERY_SELECTED_RELEASE`, `BEELINE_FORCE_REPAIR`, `BEELINE_PREPARE_DEADLINE_AT`, `BEELINE_RECOVERY_ENTRY`, `BEELINE_UPDATE_GROUP_OWNER` | Current native-manager/update recovery protocol and isolated lab identity; removing these would change lifecycle authority. |
| `BEELINE_CORNER_EMULATOR_SOCKET`, `BEELINE_CORNER_ID` | Existing corner emulator IPC identity. |
| `BEELINE_AUTH_URL`, `BEELINE_MONOLITH_BASE_URL`, `GH_REPO`, `GITHUB_REPOSITORY`, `GITHUB_API_URL`, `TRUSTY_SQUIRE_PROFILE_DIR`, `BEELINE_HOSTED_SERVICES`, `PI_ACP_PI_COMMAND` | Deployment/auth and legacy migration origins, repository context, Squire profile/hosted image selection and operator Pi command. |
| `BEELINE_SQUIRE_RELAY_URL`, `BEELINE_SQUIRE_RELAY_TOKEN` | Scoped Squire relay transport and its credential. |
| `BEELINE_FREE_AGENT_ID`, `BEELINE_FREE_AGENT_MODEL_TOKEN`, `BEELINE_FREE_AGENT_MAX_TURN_SECONDS`, `BEELINE_TURN_CONTEXT_FILE` | Hosted agent/model authority and the server-granted turn budget; the extension reads the owning turn start time. |
| `BEELINE_MCP_SURFACE`, `BEELINE_AGENT_DM`, `BEELINE_DAEMON_CORNER_ID`, `BEELINE_CORNER_REPOSITORY`, `BEELINE_GRANT_RUNNER_URL`, `BEELINE_NATIVE_IO_PROVEN`, `BEELINE_READONLY_ROOT`, `BEELINE_READONLY_EXTRA_ROOTS`, `BEELINE_READONLY_AGENT_SKILLS_ROOT`, `BEELINE_HELPER_VERSION`, `BEELINE_CORNER_SCRATCH_ROOT`, `BEELINE_ATTACH_SCRATCH_ROOT`, `BEELINE_ATTACH_ROOT`, `BEELINE_DAEMON_BASE_URL`, `BEELINE_DAEMON_ROOM_ID` | MCP child membrane: surface, Room/corner/repository authority, native-I/O proof, allowed filesystem roots, helper version and main-daemon transport. |
| `BEELINE_BODY_MAX_SESSIONS` | Existing operator resource ceiling still bounds live sessions; the independent floor override was removed. |
| `BEELINE_SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `BEELINE_RELEASE_SHA` | Optional helper error capture and release provenance. |
| `VITEST`, `NODE_ENV` | Hermetic lifecycle/quota tests and development behavior. |

### Phone (11)

| Retained names | Why |
| --- | --- |
| `NODE_ENV`, `VITEST`, `BROWSER_CONTROLS_CHROME_DRIVER`, `EXPO_OS`, `CHROME_BIN` | Development/test tracing and browser proof driver/target selection; EXPO_OS also appears in an esbuild define string. |
| `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_BEELINE_RELEASE_SHA`, `EXPO_PUBLIC_LOG_SERVER_URL` | Optional error capture, exact release attribution and developer log mirror. The log mirror network site is retained for the router worker. |
| `EXPO_PUBLIC_BEELINE_DESKTOP_UPDATES` | Preview/dev desktop shells must not install production-signed updates. |
| `EXPO_PUBLIC_BUZZY_MONOLITH_URL` | Development server override is exercised by androidLatencyRig.test.ts. |
| `EXPO_PUBLIC_DISABLE_ANALYTICS` | Explicit analytics opt-out remains separate from the manifest provider key. |

Shared packages retain zero direct environment settings.

## Parallel paths retained

No names were shortened to reduce the ratchet. Current display defaults, resource recovery, persisted upgrade readers and upstream generated code remain even when their names match legacy/fallback/compat. Network router and corner authority compatibility is reserved for those workers.

### Server (21)

| File and guarded declarations | Why retained |
| --- | --- |
| [agent-subscriptions.ts](../apps/server/src/agent-subscriptions.ts) — `function legacyView`, `function legacySubscriptions`, `function legacyId`, `const legacy` | Persisted room_access.event_subscriptions still feed both agent and Room subscription lists; legacy IDs still have deletion callers (5 sites). |
| [auth.ts](../apps/server/src/auth.ts) — `async migrateLegacyDaemon`, `const legacy` | Pre-monolith daemon credentials still have an explicit migration entry point and existing ownership checks (2). |
| [corner-reviewer.ts](../apps/server/src/corner-reviewer.ts) — `function cornerReviewerFallbacksSql` | Reviewer successor selection is active corner authority; retained for the corner worker (1). |
| [daemon-service.ts](../apps/server/src/daemon-service.ts) — `const saveCompatibilityReply` | saveCompatibilityReply is the existing non-command-transaction writer; the router/command worker owns its eventual removal (1). |
| [github-operations.ts](../apps/server/src/github-operations.ts) — `const fallbackBranch` | Fork PR branch qualification still needs the head repository when it differs from the base repository (1). |
| [one-system-thread.ts](../apps/server/src/migrations/one-system-thread.ts) — `const legacyBots` | Idempotent migration guard for historical System identities; no database evidence authorizes dropping upgrade handling (1). |
| [workflow-cleanup.ts](../apps/server/src/migrations/workflow-cleanup.ts) — `function normalizeLegacyWorkflowRuns` | migrateData still invokes the once-recorded backfill for persisted workflow attempts, gates and timers (1). |
| [operator-dashboard.ts](../apps/server/src/operator-dashboard.ts) — `const legacy` | The variable names the existing base funnel projection, not a duplicate implementation; it is included in the people projection and returned for agents (1). |
| [phone-service.ts](../apps/server/src/phone-service.ts) — `const fallbackIds`, `const nextFallbacks` | Reviewer fallback inputs still update active successor lists; corner authority is another worker’s seam (2). |
| [repository-onboarding.ts](../apps/server/src/repository-onboarding.ts) — `const fallback` | Evidence-free starter suggestions are still needed when repository inspection yields fewer than three suggestions (1). |
| [schedule-title.ts](../apps/server/src/schedule-title.ts) — `function scheduleFallbackTitle` | An unnamed saved schedule still needs a bounded derived title (1). |
| [server.ts](../apps/server/src/server.ts) — `const fallback` | Committed-delta read failures still invalidate through the existing socket recovery path; reserved for router migration (1). |
| [system-line.ts](../apps/server/src/system-line.ts) — `const fallbackSubjectName` | Missing/removed actor identities still need a safe display subject (1). |
| [workflow-runs.ts](../apps/server/src/workflow-runs.ts) — `function describedLegacyWorkflowState`, `function describedLegacyWorkflowContract` | The migration still repairs summary/does in pinned historical workflow versions; their saved bytes survive indefinitely (2). |

### Helper (29)

| File and guarded declarations | Why retained |
| --- | --- |
| [agent-corner-checkout.ts](../apps/body/src/agent-corner-checkout.ts) — `function copyLegacy`, `let legacy` | Still copies unpublished legacy checkouts into per-agent writer copies while preserving recovery evidence (2). |
| [browser-share.ts](../apps/body/src/browser-share.ts) — `let fallbackTimer`, `const scheduleFallback` | A quiet/static Chrome tab may never emit screencast frames, so its one-share timeout captures a frame and is cleared on close (2). |
| [cli.ts](../apps/body/src/cli.ts) — `function migrateLegacyAgentUnit` | Old per-agent native units launch the new bundle through this handoff before the machine helper takes ownership (1). |
| [corner-emulator.ts](../apps/body/src/corner-emulator.ts) — `function removeLegacyAdbAlias` | Cleans old operator ADB aliases without losing active emulator metadata (1). |
| [cursor-acp-bridge.ts](../apps/body/src/cursor-acp-bridge.ts) — `const fallback` | A successful Cursor result can carry final text without a streamed text event (1). |
| [harness-capabilities.ts](../apps/body/src/harness-capabilities.ts) — `static fallback`, `function usesTextTargetBranchFallback` | Pi target-branch proposal still needs its documented text command because its adapter has no permission callback (1); the other match is the comment “static fallback”, not executable code. |
| [legacy-daemon-migration.ts](../apps/body/src/legacy-daemon-migration.ts) — `function migrateLegacyDaemonTransport` | Existing runtime records without transport still enter the authenticated monolith migration (1). |
| [model-config.ts](../apps/body/src/model-config.ts) — `function resolveModelFamilyFallback`, `const fallback` | Current catalog correction must select an available model family or safe current model when an earlier selection is unavailable (2). |
| [monolith-corner-turn.ts](../apps/body/src/monolith-corner-turn.ts) — `private legacy`, `private recordModelFallback` | recordModelFallback reports current catalog correction (1); the second match is the comment “private legacy paths”, not another code path. |
| [monolith-room-turn.ts](../apps/body/src/monolith-room-turn.ts) — `private recordModelFallback` | recordModelFallback reports the same current correction for Room sessions (1). |
| [native-helper.ts](../apps/body/src/native-helper.ts) — `const disableLegacy`, `const legacyStop`, `const legacy` | Migration still retires old native unit/drop-in layouts on operator machines (3). |
| [openrouter-routing.ts](../apps/body/src/openrouter-routing.ts) — `const compat` | compat is Pi’s current provider modelOverrides protocol object, not a Beeline compatibility route (1). |
| [runtime.ts](../apps/body/src/runtime.ts) — `const legacyBirth` | Old PID birth records lack the boot identity and still require command-line ownership before reclamation (1). |
| [self-update.ts](../apps/body/src/self-update.ts) — `const legacyIdentity`, `const legacyId`, `const legacyDir`, `function normalizeLegacyBundleShape` | Directory-shaped installed bundles must be preserved and normalized before switching to release symlinks (4). |
| [setup.ts](../apps/body/src/session-join/setup.ts) — `const toFallback` | ZCode’s native MCP config hides the shared inventory when populated; install/remove must honor the operator’s actual populated source (1). |
| [storage-owners.ts](../apps/body/src/storage-owners.ts) — `function discoverLegacyStorageOwners`, `const legacy` | Recover old checkout ownership and safely identify the prior shared corner tree; missing server data never implies deletion permission (2). |
| [storage-report.ts](../apps/body/src/storage-report.ts) — `const legacyOwners` | Includes discovered old-layout storage in the operator’s report; it is not silently orphaned (1). |
| [trusty-squire-storage.ts](../apps/body/src/trusty-squire-storage.ts) — `function trustySquireLegacyStorePaths` | Both default and XDG operator credential-store roots must remain masked/protected even if sessions use the new host broker (1). |

### Phone (19)

| File and guarded declarations | Why retained |
| --- | --- |
| [_chat-surface.tsx](../apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx) — `const fallbackName` | Two safe member-name projections for missing identity labels (2). |
| [github-callback.tsx](../apps/mobile/sources/app/(app)/beeline/github-callback.tsx) — `function GitHubCallbackFallback` | The callback route remains an external deep-link destination and recovers the saved auth return (1). |
| [google-callback.tsx](../apps/mobile/sources/app/(app)/beeline/google-callback.tsx) — `function GoogleCallbackFallback` | The callback route remains an external deep-link destination and recovers the saved auth return (1). |
| [connect.tsx](../apps/mobile/sources/app/(app)/beeline/settings/workbench/connect.tsx) — `function LegacyGoogleAppRedirect` | Existing saved Google connector links still redirect to the current app connector ceremony (1). |
| [artifact-preview-cache.ts](../apps/mobile/sources/buzz/artifact-preview-cache.ts) — `function legacyArtifactPreviewPath`, `const legacyInfo` | Pre-fix blank preview files are deleted so current settled captures can replace them; devices can retain those cache files (2). |
| [design-lint.ts](../apps/mobile/sources/buzz/design-lint.ts) — `const fallback` | The linter must examine both sides of nullish/OR expressions; the variable is an expression branch, not a parallel product path (1). |
| [desktop-workbench-state.ts](../apps/mobile/sources/buzz/desktop-workbench-state.ts) — `const fallback` | Missing or invalid persisted pane widths need their current size default (1). |
| [member-display.ts](../apps/mobile/sources/buzz/member-display.ts) — `function fallbackMemberName`, `function fallbackMemberHandle` | Identity rows without a name/handle still need non-secret display labels (2). |
| [text-draft-store.ts](../apps/mobile/sources/buzz/text-draft-store.ts) — `private legacyKey`, `const legacy` | The desktop composer still passes its old persisted key into hydration; removing it would discard unsent drafts on upgrade (2). |
| [tool-call-row.ts](../apps/mobile/sources/buzz/tool-call-row.ts) — `function legacyTruncatedText` | Historical tool rows may end mid-JSON-string; bounded recovery preserves the known text field (1). |
| [presented-notifications.ts](../apps/mobile/sources/push/presented-notifications.ts) — `function clearLegacyPresentedNotificationsOnce`, `const legacyIds` | Android devices can retain untagged notifications from older binaries; their destination cannot be inferred, so cleanup is recorded once (2). |
| [browser-string-storage.ts](../apps/mobile/sources/sync/browser-string-storage.ts) — `const memoryFallback` | Browser storage can be unavailable/blocked; the current memory store keeps the app usable (1). |
| [pdfjs.gen.ts](../apps/mobile/sources/vendor/pdfjs/pdfjs.gen.ts) — `function amendFallbackToUnicode`, `async fontFallback` | Two matches are inside the generated upstream pdf.js worker payload. Its font/Unicode handling is not application compatibility code. |

### Shared (5)

| File and guarded declarations | Why retained |
| --- | --- |
| [phone-guards.ts](../packages/api-contract/src/phone-guards.ts) — `const reviewerFallbackIds` | Active DTO validation preserves reviewer successor IDs (1). |
| [display-name.ts](../packages/buzz-client/src/display-name.ts) — `function fallbackAgentName`, `function fallbackPersonName` | Current anonymous agent/person display names for missing labels (2). |
| [relay-error.ts](../packages/buzz-client/src/relay-error.ts) — `const legacyHttp` | The typed legacy relay error boundary is left to the network router migration (1). |
| [routes.ts](../packages/net/src/routes.ts) — `function legacyEntries` | legacyEntries is explicitly reserved for the network router worker (1). |
