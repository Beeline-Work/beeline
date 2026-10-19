# Suggested GitHub connection feedback

Issue: https://github.com/Beeline-Work/beeline/issues/2594

## Reproduced

Reproduction R2594 uses the rendered Connectors screen with the desktop-shell
boundary and a controlled server result. Click the `connectors-suggest-github`
Settings row with an online helper. Connection setup returns an app ID without an
authorization URL (a supported result while helper setup continues). Before the
fix, no route opens and no browser opens. The screen test failed its navigation
assertion; the authorization-link and browser-error cases already passed.

The host is Linux; the reporter's Windows session is unavailable. Exact Windows
reproduction was not obtained. This screen interaction is the closest stand-in,
not proof of a specific Windows runtime defect. Existing production code already
routes desktop authorization links through the Tauri system opener.

## Demonstrated

Repeat R2594 with the same rendered screen, helper and server response: the click
opens `/beeline/settings/workbench/app` with the returned app ID and the original
viewer/workspace scope. That existing page exposes connection state, errors and
Reconnect. When a URL is returned, the click still opens the server-issued URL
through the desktop opener. An opener rejection renders its error on Connectors.

Command (from `apps/mobile`):

```sh
./node_modules/.bin/vitest run 'sources/app/(app)/beeline/settings/workbench.github-connect.test.tsx' sources/buzz/app-sign-in.test.ts sources/utils/open-external-url.test.ts
```

Nine tests pass. The screen interaction mocks native rendering primitives and
server responses; it executes the actual screen, connection hook, app sign-in
storage and desktop external-link dispatch. It does not authorize GitHub access.

## Deployed browser attempt

Trusty Squire opened `https://web.usebeeline.app` and navigated Settings →
Connectors. It used the existing lunchboxfortwo owner session. Existing connections
meant the Suggested section was absent; no GitHub setup or permission change was
performed. This did not reproduce the report and is not proof of this branch's
behavior on the deployed site.

The approved reviewer-bypass connection reports ready. Vault metadata identifies
`play-review-login-link` with one `value` field restricted to Beeline web hosts.
The mounted navigation tool accepts a plaintext URL; saved-login slots fill form
controls, and no sealed-link navigation operation is mounted. No secret was
retrieved. Required reviewer-bypass browser proof remains outstanding. The supported next step is Play Review sign-in through the shared reviewer
browser and same-session handback (see below). No release or production deployment is assigned or performed.

Related PR search found no superseding fix for this click handler.

## Revised repository guidance (revision 5)

On 2026-10-19, a new read-only Squire browser session on the deployed site
confirmed General → Room settings → Repository None/change → Link/Create →
Choose a repo, listing existing personal and organization repositories. No
repository was selected, and no authorization or binding changed. The owner
already has a GitHub key, so this session cannot demonstrate Suggested GitHub.
This confirms the guidance's navigation, not deployment of this branch.

The assembled repository-less Room prompt now guides repository setup before
personal connector setup. A real-model replay with the actual prompt and
using-beeline skill returned actionable Room header → Repository → Link/Create
guidance and the missing-organization installation action. See
`guidance-replay.md`. This is a model replay, not an agent turn deployed in
General. The saved case is in the format of pending PR #2606; its runner is not
on this branch yet.

An actual deployed General conversation now supplies criterion 4's verbal
guidance proof. Request `dd1731771bfb17af334754216d40c35f4f75c6a04fff326c5785a6c6817df5d1`
asks for a login fix with no linked repository and unavailable gh. Response
`1b8f1cdd1b9c21992115e249a175f5a3c3a26352cd588e0ac104438a7542430e`
guides organization installation approval, linking the repository from Room
settings, and checking installation repository access. The same browser showed
“THIS ROOM ISN’T LINKED TO A REPO”, a repository picker, and “Add repositories,
accounts, or organizations”. No repository was selected. The typing tool timed
out after entering a partial draft; the observed draft was submitted once, and
the stored request ends at “con”. Its complete missing-repository request and
“Do not open a corner, change any code” instructions are present. This is
deployed behavior, not a claim that the branch's more specific menu guidance
has shipped.

Personal GitHub API precedence is now explicit in the always-on tool guidance,
the using-beeline skill, and in
the `connect(mode:status)` result for an existing personal GitHub app. The hint
names its owner-scoped app and transport, prefers supported personal API
operations including Git Data pushes, and forbids App fallback after denial.
App-only checkout remains on the existing path. Tests cover personal status,
App-only access, managed-tool permission refusal, and the actual Squire relay
path preserving both a successful and a refused Git Data update without retry.
Owner authorization denial is also tested before any upstream vault call.
Managed routes name the exact connected app ID; sealed routes name
`use_credential(service:"github")`.

The saved personal API-push case passed three of three local model samples:
each checked connection status and chose the personal app ID for the
non-force reference update. The App-only case passed three of three samples
without requesting a personal connection. These are simulated tool-choice
replays, not real pushes. See `credential-routing-replay.json`. Claude rejects
top-level schema composition, so the local replay used a provider-compatible
projection that omits those schema fields; production runtime validation is
unchanged. The unmodified pending #2606 runner remains unverified here, and its
owner was notified about this provider boundary.

The owner approved API push proof in brief revision 4. On 2026-10-19, sealed
personal GitHub `/user` authenticated as `lunchboxfortwo`; reading this corner's
feature ref and its Git commit returned HTTP 200. Independently, the native App
route's `gh api /installation/repositories --jq '.repositories[].full_name'`
returned only `Beeline-Work/beeline`, confirming both routes were configured.
The personal `POST /repos/Beeline-Work/beeline/git/refs` request for
`refs/heads/proof/github-personal-2594-20261019-mvfhq0wa`, at commit
`8f68adbe1bd0f7de3b8027931b78a3db4559212f`, returned HTTP 403. No branch was
successfully created or pushed, and no App fallback was attempted. A working
personal push remains unproven. Repository push permission on the user does
not establish permission on the particular token; GitHub documents
[Contents write permission for this operation](https://docs.github.com/en/rest/git/refs#create-a-reference).

Reviewer session `dc6e9578-3447-4c7e-9e72-5d0cb6eb6443` opened the deployed
site in the existing owner account. It is shared live through the Beeline
browser-share card for a person to sign in as Play Review and hand back the
same session. No logout or unsupported sealed-link operation was attempted.
Authenticated reviewer proof remains outstanding; this PR must remain draft.
Personal push proof subsequently passed as recorded below.

Local validation: `npm run corner:prepare`, root `npm run typecheck`, 226 body
prompt/skill/app-tool/Squire relay tests, 11 released Workbench MCP tests, and
45 native git/gh wrapper tests passed. Saved behavior cases follow pending PR #2606's format; that replay
runner is not on this branch. The merged main branch added a Room-with-Squire
snapshot, which was refreshed to include the repository guidance.

## Personal GitHub write repair and successful API push

On 2026-10-19, the same owner's GitHub settings identified the exact cause of
that 403: `buzzrouter-public-discovery` is a read-only public discovery token,
with no repository access and no repository permissions. Its existing use was
preserved. GitHub sudo verification succeeded through the owner's connected
email route; no human GitHub challenge remains.

A separate fine-grained personal token, `beeline-work-beeline-contents`, was
created through Trusty Squire and captured directly into its vault. GitHub's
final confirmation specified only `Beeline-Work/beeline`, Contents read and
write, and required Metadata read-only, expiring November 18, 2026. It stated
that the token was ready immediately; no pending organization approval appeared.
No secret was returned to the agent or written to this repository.

All requests below used that same explicit sealed personal credential reference,
with server-side Authorization injection. No request switched to the App route.
The App remained configured: its independent installation repository listing
returned `Beeline-Work/beeline` immediately before the personal write proof.

| Request | Result |
| --- | --- |
| `GET /user` | 200; login `lunchboxfortwo`, user ID `269599412` |
| `GET /repos/Beeline-Work/beeline/git/ref/heads/feature/corner-7005eea7f6b8` | 200; base `7ec59909601acba38a5410f2cbb2d6096d8a20ae` |
| `GET /repos/Beeline-Work/beeline/git/commits/7ec59909601acba38a5410f2cbb2d6096d8a20ae` | 200; tree `544d73a0e8e6f8163e12a9d24990fff2f76080dd` |
| `POST /repos/Beeline-Work/beeline/git/refs` | 201; created `refs/heads/proof/github-personal-2594-20261019-1718` at the base |
| `POST /repos/Beeline-Work/beeline/git/commits` | 201; new commit `26a331189ce4ed799199f558b8e8e45c13add08c`, same tree, base as parent |
| `PATCH /repos/Beeline-Work/beeline/git/refs/heads/proof/github-personal-2594-20261019-1718` with new SHA and `force:false` | 200; advanced proof branch to new commit |
| `GET /repos/Beeline-Work/beeline/git/ref/heads/proof/github-personal-2594-20261019-1718` | 200; confirmed new commit |

GitHub defaulted both author and committer to `lunchboxfortwo`; neither field
was supplied in the commit request. The authenticated `/user` response and all
writes used the same explicit sealed reference. This demonstrates the approved
personal Git Data API push alternative with both credentials configured. It does
not demonstrate native git credential injection. Main and the feature branch
were untouched by the proof. The empty proof commit changes no files.

The GitHub repair browser was closed after vault capture and successful proof.
The separate shared reviewer session remains open at the deployed Beeline site;
Play Review sign-in and same-session handback is the only known remaining human
step. It has not been represented as completed reviewer proof or merge approval.
`npm run corner:prepare` passed again after the proof; this update changes evidence
only, so the earlier 291 focused tests and typechecks remain the code validation.

## Main integration and checks repair

Integrated main at `64f9a1a9b` and resolved the add/add conflict in the generated
`room-squire` prompt snapshot by retaining this branch's repository guidance and
personal GitHub precedence. The merged prompt assembly matches every snapshot.
The previous BODY SUITE failure was this stale snapshot; its regression now passes.
After integration: full root typecheck, 243 Body tests, 98 server tests (GitHub
operations, Workbench routing and brief refusals), nine connector/sign-in/opener
tests, and workflow-path lint pass. Authenticated Play Review browser proof remains
pending; this integration does not claim that proof or a release.

## Accepted authenticated browser proof and second main integration

This section supersedes the earlier pending-sign-in notes. On 2026-10-19,
owner-approved retrieval of the vaulted reviewer link allowed local Chrome to
open the existing review route on `web.usebeeline.app`. The app authenticated as
Play Review; Settings displayed `@play-review` and deployed version
`v0.1.86 · 80b870764d03`. Settings → Your connections showed 52 connections,
including GitHub with one key. Clicking that GitHub row opened
`/beeline/settings/workbench/service`, with GitHub details and the existing
Buzzrouter public discovery key. No settings or connections changed.

Suggested is absent for this reviewer fixture too. The owner accepted this
signed-in deployed inspection together with the existing R2594 rendered
regression (Room message e6aa4917, “Ok on 1”). No deployed Suggested click or new
account is required. This proves the authenticated deployed path inspected,
not deployment of this branch. Full observation:
https://github.com/Beeline-Work/beeline/pull/2599#issuecomment-6276507656

The second integration with main preserves its consolidated prompt sections and
moves this branch's repository guidance and personal GitHub preference into
those sections. Generated snapshots were refreshed. Main's duplicate-sentence
regression caught the checkout/merge pointer in both prompt and tool guidance;
it remains in tool guidance and was removed from the prompt.

Validation: full root typecheck, workflow-path lint, 229 focused Body tests,
30 additional app-tool/order tests, three prompt-layer tests, nine connector,
sign-in and desktop-opener tests, and four Node prompt-case-rule tests pass.
The final prompt/snapshot run passed all 123 assembly/layer tests. The Node
rule file was initially invoked with Vitest, which reported no Vitest suite;
its intended Node test runner passed all four tests. R2594 retains the same
controlled screen, setup responses and desktop opener boundary.
