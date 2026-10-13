# Mobile client and UI invariants

Paths and commands below are relative to the repository root. Read these invariants before editing this area; named code and tests hold implementation detail.

## Composer command authority

- **Composer commands keep two authorities separate.** `BEELINE_SLASH_COMMANDS` (`packages/buzz-client/src/slash-command.ts`) owns Beeline actions, filtered by live permissions; an agent's ACP `available_commands_update` snapshot (`agentCommandCatalogPublisher` → `agents.commands`) owns its commands. Picking one keeps the `@agent` mention, so routing and access policy still gate it. Owner-only `/fast-mode` (`fastModeCommandState`) calls `updateAgentModelSelection`.

## GitHub identity

- GitHub identity and repository access authority: [auth README](../apps/auth/README.md).
- **Mobile sign-in** (`apps/mobile/sources/auth/github-auth-session.ts`) seals identity before the browser opens and keeps one state-bound pending session; a recovery token lets `/auth/github/completion` finish even if Android drops the callback. A callback deep link routes a second onboarding screen, so press outcomes live in `auth/onboarding-state.ts`, not component state.

## Mobile client

- **A saved sign-in survives network failures and inactivity.** `loadBuzzIdentity` (`auth/buzz-identity-storage.ts`) restores the saved identity locally; operations renew access themselves. `TokenAuth.refresh` (`apps/server/src/auth.ts`) retains the device credential, recovering legacy sealed successors; only explicit device revocation or account deletion ends it. `runMaintenance` sweeps access tokens, never device sessions. Coverage: `buzz-identity-session.test.ts`, `monolith-session.test.ts`, `auth.test.ts`.
- `apps/mobile` is vendored Happy, isolated from root workspaces (`npm run mobile:install`); `@beeline/*` resolves to built `dist/` via Metro. Android `app.usebeeline`, iOS `app.usebeeline.mobile`, scheme `beeline://`. Reads go through `RoomViewClient`; MMKV holds only scoped DTOs + outbox.
- **A mobile fix must not depend on a brand-new `@beeline/buzz-client` export**: Metro reads `dist/`, and a missing symbol inside `.catch` fails silently. Rebuild `@beeline/nostr` and `@beeline/buzz-client` after SDK edits.
- **Mobile tests:** read rendered text from `.props.children`, never `.children` or `JSON.stringify(node)`; pretty-format walks the circular Fiber graph and OOMs the worker.
- **The foreground never blocks on the network.** The transcript FlatList is `inverted` with `maintainVisibleContentPosition`; cells are upright, so a byline cushion is `paddingTop`. Scroll-follow holds during drag and fires once per arrival. `buzz/room-message-store.ts` is the only module that loads Room history (`room-message-store.boundary.test.ts`). A message-source jump (`jumpTo`) opens a window that keeps the target near its newest end, so the inverted list draws it at once and one `scrollToIndex` puts it at the top; the window pages toward both ends until it joins the recent tail, and historical rows do not count as live arrivals. Nothing covers the room while a jump loads, and a session reset re-runs an unfinished jump. `foldTranscriptRows` maps every message id to the row that shows it, so a folded target lands on its host row.
- **Floating surfaces:** `ModalManager.ts` presents everything; `HullDialog.tsx` owns the only RN `Modal`; `HullActionSheet.tsx` owns the sheet primitives; no `Alert.alert` (`native-dialog-enforcement.test.ts`).
- Route defaults under `apps/mobile/app/` are Expo Router routes. Reuse `SettingsRow.tsx`, `MemberPickerSheet.tsx` and `RoomRosterSheet.tsx` for their existing surfaces.
- **Artifacts:** `ArtifactCard` is the preview; HTML/SVG run script-off via `artifactWebViewProps`; only the pdf.js view gets JavaScript. Load `react-native-webview` with `import()`, never `require()`. The desktop second pane holds one thing or nothing (`DesktopWorkPaneContent`, `desktop-workbench-state.ts`); artifacts it cannot take open in the full-screen viewer.

## Push notifications

- `apps/server/src/background.ts` sends Android via Firebase and iOS via `apns-push.ts` (when `APNS_KEY_P8_BASE64` is set); `firebase-push.ts` is the one payload serializer and every target carries its Workspace. Push covers DMs, tags, replies and addressed decisions; Full also covers human messages, final agent turns and member lifecycle; levels `off`/`attention`/`full` (Attention: tags, DMs, replies and addressed decisions; Full adds human messages and final agent turns across member Rooms/corners) (`push-level.ts`).
- A tapped push outranks the startup redirect (`push/notification-response.ts`, `navigation/initial-landing.ts`). `plugins/withAndroidPushRouting.js` + the `expo-notifications` patch keep the newest tap. `push-actions.ts` defines `grant` and `reply` actions answered without opening the app.

## Mobile UI

- **Render failures remain visible.** `RuntimeErrorBoundary.tsx` contains composer/voice failures; the root route exports its provider-free `RuntimeErrorView`. Keep its native primitives outside the Unistyles Babel rewrite. `client-error-report.ts` sends bounded diagnostics to the authenticated server log endpoint; reporting and cleanup failures never suppress the original error. Proof: `apps/mobile/evidence/voice-error-recovery/README.md`.
- **Android native crashes survive process death.** `modules/android-crash-trace` records fatal JVM exceptions before delegating to Android and reads Android 12+ signal-crash tombstones through `ApplicationExitInfo`. `native-crash-reporting.ts` sends the private receipt on launch/sign-in/resume and acknowledges only accepted reports. Never add a crash trigger to shipped code. Proof: `apps/mobile/evidence/native-crash-recovery/README.md`.

- [DESIGN.md](../DESIGN.md) is the UI authority; tokens live in `apps/mobile/sources/buzz/groknight.ts`. Box only what the user acts on or a non-repeating region.
- **Shared controls:** `Button`, `HullDialogActions`, `HullActionSheetCancel`, `HullDialogInput`, `MemberRosterRow`, `RoomListSectionHeader` and `ServiceMark` own their UI roles. ServiceMark delegates to the 36px AppMark tile. Preserve caller permissions, callbacks, native field props and server action order when migrating a surface.
- **UI policy:** `scripts/check-mobile-ui-components.mjs` is the required TYPECHECK scanner; `scripts/mobile-ui-policy.test.mjs` covers it. The registry permits only shrinking legacy budgets. Layout shells fingerprint their own props/styles and recursively check children; cancellation/retry controls and text fields cannot be grandfathered or hidden in a registered component.
- **Type roles only.** `calm-lint.design.test.ts` ratchets raw and computed `fontSize`/`lineHeight`/`letterSpacing` values in `.ts`/`.tsx` against `apps/mobile/design/calm-baseline.json`; counts only shrink.
- **Tokens, scale, one component each.** `design-lint.design.test.ts` ratchets colour literals, off-scale spacing and radii, shadows, retired fonts and retired components against `apps/mobile/design/design-baseline.json` (DESIGN.md → Enforcement); counts only shrink.
- **Room status paints the full margin and overlaps composer padding** (`room-bottom-chrome.ts`, `TurnBandSlot`; `room-bottom-chrome.test.tsx`). Accepted but unclaimed commands stay silent; they never hide the working line or add stacked status height (`chat/roomIndicators.test.ts`).
- **Rooms and corners render one ledger** (`Ledger.tsx`); ownership reads from the byline (`ledger-attribution.ts`). A live draft renders as plain `Text` in `StreamingProse.tsx`, never Markdown. A tool step is one line (`buzz/tool-ledger.ts`, `ActivityTimeline.tsx`); output opens in `ToolOutputSheet`.
- Composer centering means the cap-to-baseline body, excluding descenders (`ConversationComposer.tsx`); native span line heights stay unset. Device/font-scale proof: `apps/mobile/evidence/composer-hint-center/README.md`.
- **Identity marks are one component** (`IdentityMark.tsx`); an agent's face is server-assigned, never re-derived from a seed. The live ring paints outside the tile box, so a clipping ancestor must outset by it. Generated portraits (`postAgentAvatar`, `/v1/agent-avatars/`) are separate from photo overrides.
- Drawn glyphs spread the platform-split props from `components/buzz/decorative-glyph.ts`/`.web.ts`; react-native-svg forwards unknown props to the element.
