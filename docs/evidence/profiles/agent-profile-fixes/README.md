# Agent profile: one removal and a bounded model list

Captures come from this branch's running Expo web client at **390×844**
(phone) and **1440×1000** (desktop), dark appearance, backed by a fresh local
monolith (`.verification/design-audit/fixture-server.mts` with
`AUDIT_AGENT_PROFILES=1`, PGlite) and a disposable proof account signed in
through `/review/design-audit-review-secret-0001`. No production Workspace.

## 1–2. Remove from Workspace is the only agent removal

An agent is never banned: its owner can pair the same helper back as a new
agent, so a ban blocks nothing. Both the owner's edit view (Candy) and a
Workspace manager's view of someone else's agent (BBC) now show one
full-width, red-bordered **Remove from Workspace** button with centred text,
in the place BBC's Ban button held. It calls `removeAgent`, which the server
already allows for the agent's owner or a Workspace owner/admin. Human
profiles keep Ban unchanged.

| View               | Phone                                                    | Desktop                                                      |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------ |
| Owner edit (Candy) | [phone-candy-owner-edit.png](phone-candy-owner-edit.png) | [desktop-candy-owner-edit.png](desktop-candy-owner-edit.png) |
| Manager (BBC)      | [phone-bbc-manager.png](phone-bbc-manager.png)           | [desktop-bbc-manager.png](desktop-bbc-manager.png)           |

## 3. The model list is bounded to five rows

The open option list shows at most five 44pt rows
(`AGENT_MODEL_PICKER_VISIBLE_ROWS`) and scrolls inside that bound — measured
in the live bundle: list 220px tall, 12 rows, 528px of scroll content.

The list's contents are unchanged: it is the helper's own live, validated
harness catalog. Charles's helper runtime record
(`~/.local/state/beeline/agents/9c874349…/runtime.json`) records
`agentKind: "cursor"` with model `claude-opus-5-thinking-high` — a Claude model
on a Cursor harness, which genuinely runs GPT models too — and the list is left
as is for Charles.

| Frame                 | Phone                                                                  | Desktop                                                  |
| --------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| Charles picker (open) | [phone-charles-picker.png](phone-charles-picker.png)                   | [desktop-charles-picker.png](desktop-charles-picker.png) |
| Scrolled to the end   | [phone-charles-picker-scrolled.png](phone-charles-picker-scrolled.png) |                                                          |

## Repeat

```
AUDIT_AGENT_PROFILES=1 AUDIT_WEB_ORIGIN=http://127.0.0.1:8093 AUDIT_SERVER_PORT=4331 \
  node --import tsx .verification/design-audit/fixture-server.mts
cd apps/mobile
EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:4331 npx expo start --web --port 8093
# then /review/design-audit-review-secret-0001, then
# /beeline/agent-profile?communityId=<workspaceId>&agentId=<c|d|e ×64>
```
