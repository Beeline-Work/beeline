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

Eight tests pass. The screen interaction mocks native rendering primitives and
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
retrieved. Required reviewer-bypass browser proof remains outstanding. The next
step is an approved sealed-link browser route or a commander-approved alternative
proof. No release or production deployment is assigned or performed.

Related PR search found no superseding fix for this click handler.

## Revised repository guidance (revision 3, work in progress)

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

Personal credential inspection through Squire's sealed HTTP boundary returned
GitHub `/user` identity `lunchboxfortwo` and repository permissions including
`push: true` for `Beeline-Work/beeline`. No personal push was attempted. The
current corner git launcher still refreshes the Beeline App token. Squire's
mounted personal credential route provides HTTP requests, not credential
injection into native git; personal push precedence remains unimplemented.
Revision 3's actual agent-chat and successful personal-push criteria remain
outstanding. This PR must remain draft and must not be approved as complete.

Local validation: `npm run corner:prepare`, root `npm run typecheck`, and 154
body prompt/skill tests passed.
