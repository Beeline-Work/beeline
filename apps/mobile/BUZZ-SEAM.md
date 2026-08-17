# Buzz seam analysis — Happy → `RigTransport`

This document maps every MVP method from `spec.md` Appendix ("Happy
`RigTransport` adapter") onto Happy's existing transport/sync layer, with
**file:line** cut-over points for the Buzz adapter lane.

**Interface (TypeScript):** `sources/sync/transport/rig-transport.ts`  
**Implementation:** `sources/sync/transport/buzz-rig-transport.ts` (every Buzz screen imports
`BuzzRigTransport` directly; the `happy-rig-transport.ts` scaffold and its
`getRigTransport()`/`setRigTransport()` cutover seam described below were never adopted and
have been removed)  
**Flags:** `sources/constants/buzzyFlags.ts` (terminals + friends social hidden)

No Buzz networking is wired in this PR. Happy's backend remains the runtime.

---

## Architecture (Happy today)

```
UI (SessionView, AgentInput, PermissionFooter, AllFilesDiffView, …)
        │
        ▼
  sources/sync/sync.ts          ← sessions list, sendMessage, socket updates, backfill
  sources/sync/ops.ts           ← session RPC (abort, permission, readFile, bash, archive)
  sources/sync/apiSocket.ts     ← socket.io + HTTP to Happy server
  sources/sync/storage.ts       ← Zustand store: sessions, messages, agentState
  sources/utils/worktree.ts     ← git worktree create/remove via machineBash
  sources/sync/gitStatusFiles.ts← changed files via sessionBash git status
```

**Realtime path:** `ApiSocket` connects with socket.io; `Sync.subscribeToUpdates`
handles session/agentState/message update events and feeds `storage.applyMessages`
/ `applySessions`.

**Permission path:** agentState carries pending requests → tool views render
`PermissionFooter` → `sessionAllow` / `sessionDeny` → `apiSocket.sessionRPC(..., 'permission', ...)`.

---

## Method → Happy call site → Buzz target

| RigTransport method | Happy cut-over (file:line) | UI entry | Buzz target (spec) | Rank |
|---|---|---|---|---|
| `sessionCreate` | `ops.ts:258` `machineSpawnNewSession` → machine RPC `spawn-happy-session` (`ops.ts:300`); Rig helpers `rigSessionCreation.ts:227` `buildRigSpawnConfiguration` | `app/(app)/new/index.tsx` (new session composer) | ACP `session_new` (acp.rs:662) + worktree open in subchannel | **1** |
| `sessionsRead` | `sync.ts:938` `fetchSessions` → `GET /v1/sessions` (`sync.ts:942`); applied via `storage.ts:403` `applySessions` | `MainView` / session list via `storage.sessions` | Active sessions scoped to TLC membership | **1** |
| `sessionRead` | `storage.ts` `sessions[id]` (interface at `storageTypes.ts:364`); loaded by `fetchSessions` | `app/(app)/session/[id].tsx`, `SessionView.tsx` | Reconstruct from backfill + run state | **1** |
| `sessionArchive` | `ops.ts:1001` `sessionArchive` → `POST /v1/sessions/:id/archive` (`ops.ts:1003`) | session info / archive actions | `session_cancel` + archive worktree | **2** |
| `messageSubmit` | `sync.ts:573` `Sync.sendMessage` → encrypt + outbox + `/v3/sessions/:id/messages` (`sync.ts:1853`) | `AgentInput.tsx` `onSend` → SessionView | ACP `session_prompt` (acp.rs:725) | **1** |
| `runAbort` | `ops.ts:740` `sessionAbort` → `apiSocket.sessionRPC(sessionId, 'abort', …)` (`ops.ts:745`) | `AgentInput` abort / SessionView | ACP `session_cancel` (acp.rs:818) | **1** |
| `sessionEventsSubscribe` | `sync.ts:2142` `subscribeToUpdates`; socket handlers continue ~`sync.ts:2160–2360`; `apiSocket.ts:158+` `rpc-call` / update events | SessionView live transcript | ACP `session/update` (acp.rs:1217) → assistant deltas + `permission_review` | **1** |
| `sessionEventsBackfill` | `sync.ts:1987` initial messages fetch; `sync.ts:2021` after_seq; `sync.ts:2099` before_seq (`/v3/sessions/:id/messages`); applied `sync.ts:2768` `applyMessages` | Session open / scroll-up | Replay from channel history | **2** |
| `permissionRespond` | `ops.ts:753` `sessionAllow`, `ops.ts:787` `sessionDeny` → RPC `'permission'` (`ops.ts:755`, `ops.ts:789`) | `components/tools/PermissionFooter.tsx:147–256`; `AskUserQuestionView.tsx:244` | Answer `session/request_permission` (acp.rs:1223) | **1** |
| `worktreeCreate` | `utils/worktree.ts:35` `createWorktree` (via `machineBash` git worktree add) | new-session / worktree flows in `new/index.tsx`, session info | Git worktree + branch on body; open session in it (= subchannel) | **1** |
| `worktreeArchive` | `utils/worktree.ts:154` `removeWorktree` | merge/close paths (sparse in Happy UI) | Remove on merge/close | **2** |
| `changedFileRead` | `ops.ts:848` `sessionReadFile` → RPC `'readFile'`; UI `AllFilesDiffView.tsx:145`, `session/[id]/file.tsx:236` | Files / diff panels | `api/git` diff content | **2** |
| `workspaceFilesRead` | `gitStatusFiles.ts:33` `getGitStatusFiles` (sessionBash git status --porcelain=v2) | Changes sidebar / `AllFilesDiffView.tsx` | `api/git` file list | **2** |
| `changedFilesRevert` | **No first-class Happy RPC** — would be `sessionBash` + `git checkout -- <paths>` if added | (not a single shared helper today) | `api/git` checkout / revert | **3** |
| `mergeAction` | **Does not exist in Happy** | (to build in P2: Approve button) | Workflow approval grant on `approval_token` (kinds 46010/46011/46012) | **3** (P2 UI) |
| `terminalCreate` | **STUB** — `RigTransportStubbedError` | was `app/(app)/terminal/*`, settings QR | n/a (no live PTY) | stub |
| `terminalStop` | **STUB** | — | n/a | stub |
| `terminalConnect` | **STUB** — Happy: `hooks/useConnectTerminal.ts:18` | settings connect terminal (now flagged off) | n/a | stub |

**Rank key:** 1 = must cut for P1 shared session surface; 2 = P1 polish / files; 3 = P2 merge gate or sparse Happy surface.

---

## Where state enters the UI (quick map)

| Concern | Store / hook | Primary files |
|---|---|---|
| Session list | `storage.sessions` via `applySessions` | `storage.ts:403`, `sync.ts:1028` |
| Messages | `sessionMessages` via `applyMessages` | `storage.ts:628`, `sync.ts:2768` |
| Permission requests | `session.agentState` (requests map) | reducer + `PermissionFooter.tsx` |
| Realtime | socket update handler | `sync.ts:2142+`, `apiSocket.ts` |
| Git changes | `getGitStatusFiles` / `gitStatusSync` | `gitStatusFiles.ts`, `gitStatusSync.ts:282` |
| Send | `sync.sendMessage` | `sync.ts:573`, `AgentInput.tsx` |

---

## Adapter lane cut-over order (recommended)

1. **Introduce** `setRigTransport(new BuzzRigTransport(...))` at app boot (auth/channel join).
2. **Swap rank-1 call sites** to go through `getRigTransport()` instead of direct `sync`/`ops` imports — start with:
   - `messageSubmit` ← `SessionView` / `AgentInput` send path
   - `permissionRespond` ← `PermissionFooter`
   - `runAbort` ← abort button
   - `sessionsRead` / `sessionRead` ← list + detail (or keep reading `storage` but feed it from Buzz backfill)
   - `sessionEventsSubscribe` ← replace `subscribeToUpdates` for session-scoped events
   - `sessionCreate` + `worktreeCreate` ← new-session / edit-mode trigger
3. **Files:** `workspaceFilesRead` / `changedFileRead` for diff panels.
4. **P2:** `mergeAction` + parent-owner Approve UI.
5. Leave `terminal*` stubbed; keep `BUZZY_FLAGS.hideTerminalUI === true`.

Full UI re-plumb (account → channel membership) is **not** a transport swap — see
spec.md "Happy's re-plumb is the real work". This seam only covers the ~10
agent/session methods.

---

## Explicitly out of scope / deferred (do not cut over yet)

- `sessionFork`, `sessionReset`, rewind, compact, `messageSteer`, slots/applets
- Friends social (`BUZZY_FLAGS.hideFriendsSocial`)
- RevenueCat / voice / ElevenLabs
- Happy server auth as long-term identity (Buzz: npub keys + channel join)

---

## Verification of this analysis

Line numbers refer to upstream Happy vendor drop at commit
`2c8ecacc19f14abd81111a4605ac8c7f6bedb7e1` (see `UPSTREAM.md` / `README.md`).
Re-check with `rg` if you rebase the vendor.
