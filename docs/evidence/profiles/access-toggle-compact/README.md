# Human profile: compact access level + grant ledger detail

Two captain items on the human profile, both display-only. Captures come from
this branch's running Expo web client at **1440×1000** (desktop) and
**390×844** (phone), backed by a fresh local monolith
(`.verification/design-audit/fixture-server.mts`, PGlite, port 4310) and a
disposable proof account signed in through
`/review/design-audit-review-secret-0001`. No production or captain Workspace,
no static mock; the browser drove the real branch bundle through
`chrome-devtools-axi`.

## 1. The ACCESS LEVEL control hugs its labels

The Member/Admin segmented control (`person-role-selector` in
`apps/mobile/sources/app/(app)/beeline/human-profile.tsx`) carried `flex: 1`
on each option, so the two plates filled the whole profile content column.
Measured in the live bundle:

| Viewport | Before | After |
| --- | --- | --- |
| 1440×1000 | selector **952px** (Member 472, Admin 472) in a 984px column | selector **166px** (Member 85, Admin 73) |
| 390×844 | selector **358px** (Member 175) in a 390 window | selector **166px** |

The phone shared the same stretch at its own scale, so the one style serves
both: the row is `alignSelf: 'flex-start'` with padding-driven plates, and the
44pt hit target is unchanged. No new control vocabulary — this is the profile
page's own section-head left edge, and the plates keep the shared border,
radius, and `space.sm` gap DESIGN.md already asks of choice plates.

| Frame | Before | After |
| --- | --- | --- |
| Desktop edit mode | [desktop-edit-before.png](desktop-edit-before.png) | [desktop-edit-after.png](desktop-edit-after.png) |
| Phone edit mode | [mobile-edit-before.png](mobile-edit-before.png) | [mobile-edit-after.png](mobile-edit-after.png) |

## 2. The grant ledger states its provenance and discloses the rest

Each row is now a `SettingsRow` disclosure (`MemberGrantRow.tsx`): the agent's
mark, the target, the agent's stated reason on its own line, then the
provenance line `grantProvenanceLine` (`buzz/agent-grant-copy.ts`) builds —
`approved by <who>, <date> · one-time|standing`, plus `· auto-approved` and
`· expires <date>` when set. A settled refusal reads `denied by` / `revoked
by`, which is the honest verb for those two. Tapping opens the rest —
`Requested by @handle`, the Room (its name when the viewer's Workspace read
carried one, the id otherwise), and the bound script when there is one.

The read is unchanged: the projection (`readWorkspaceMembers`) still shows a
Workspace-visible repository grant to any member and a personal-resource grant
only to the agent's owner, so the frames show the three repository grants the
disposable account can see: one standing, one `once`, and one yolo approval
with an expiry.

| Frame | Phone | Desktop |
| --- | --- | --- |
| Ledger + provenance | [mobile-grant-expanded-after.png](mobile-grant-expanded-after.png) | [desktop-grant-expanded-after.png](desktop-grant-expanded-after.png) |

## Repeat

```
AUDIT_WEB_ORIGIN=http://127.0.0.1:8083 AUDIT_SERVER_PORT=4310 \
  AUDIT_AGENT_OWNER=peer \
  node --import tsx .verification/design-audit/fixture-server.mts
cd apps/mobile
EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:4310 npx expo start --web --port 8083
# then /review/design-audit-review-secret-0001, then
# /beeline/human-profile?communityId=<workspaceId>&memberId=<peer>
```

`AUDIT_AGENT_OWNER=peer` is what puts the seeded agents and their repository
grants under the profiled member; the default (`viewer`) leaves the profiled
member with none.

## Validation

- Mobile typecheck: `npm run typecheck --prefix apps/mobile`
- Root typecheck: `npm run typecheck`
- Mobile suite: 368 files / 3118 tests. One run tripped a vitest worker
  `onTaskUpdate` timeout on `sandbox-webview.unavailable.test.tsx`, which is
  untouched here and passes in isolation.
- `grantProvenanceLine` vocabulary, `MemberGrantRow`, `Members workspace
  management`, and `Human profile layout contract`
- Every frame captured from the running branch, and each verified against the
  live DOM (rendered text plus the control's measured width) at capture time