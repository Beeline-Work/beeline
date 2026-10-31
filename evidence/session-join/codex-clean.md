# SESSION-JOIN-CODEX-CLEAN-1

Clean first-join follow-up to merge gate c15e4c7f. This supersedes the full-access Codex proof caveat in the original evidence. It does **not** claim the untouched initial Codex permission policy can complete Join.

## Isolation and stock failure

Two independent fresh homes were authenticated through normal Codex sign-in. Both started with no config file, no hooks file, no Beeline state, no writable-config allowance and no trusted hooks. The CLI was (0.165.0). Launch used `env -i` with only PATH, HOME, CODEX_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, TERM and LANG; no permission flags or trust-bypass flags. [Final baseline](codex-clean/final-baseline.json), [first baseline](codex-clean/first-baseline.json).

The untouched initial policy was workspace-write with network disabled and granular `sandbox_approval: false`, `request_permissions: true`. Its permission-request tool was not exposed. Join failed creating its user state directory outside the workspace; the native agent said its policy prevented asking for approval. In the first run it also retried with state under `/tmp` and then hit the network denial. That workaround was abandoned. The final run kept the original state and config paths. These failures and all operator messages appear in the native extracts.

Selecting `/permissions` → **Ask for approval** changed the policy to `on-request`, while preserving workspace-write and network-disabled sandboxing. This menu choice granted no directory or command allowance. This is an extra native UI choice before sign-in on this installation; it is not an untouched-default success. [Exact menu capture](codex-clean/final-permissions-menu.txt), [policy snapshots](codex-clean/final-policy.json).

## What the person sees

1. Paste “Join my Beeline Room” in the fresh session. On the installed initial policy, the native session reports it cannot ask for permission; select **Ask for approval** in `/permissions` and retry Join.
2. Codex asks **“Would you like to run the following command?”**. Its reason is “Allow this exact Beeline join command once to write its session configuration and connect to the local Room?” The command is only the Beeline join command. Choose **“Yes, proceed (y)”**, not the permanent-rule choice. [Full terminal capture including every option](codex-clean/final-one-time-prompt.txt). No Full Access selection, writable root exception or persistent command rule was used.
3. Codex shows the sign-in link. Chrome opens it, follows GitHub sign-in and shows Allow. The added Codex sentence names that exact native prompt and **Yes, proceed**. [Actual live Allow text](codex-clean/live-allow.txt). Sign-in uses the existing built-server proof's synthetic GitHub provider; the native CLI and Chrome are real.
4. Tap Allow. Beeline installs its own hook and the native thread displays “Trusted only Beeline’s SessionStart hook, pinned to its current Codex hash.” No further config-write or hook-trust prompt appears.
5. Tag the joined handle. The exact live thread wakes and posts `CODEX_CLEAN_FINAL_ACK` in the Room using its workspace outbox, with no further user input or permission prompt.

## Passing rerun on the final renderer

Native thread: `01a193d5-9316-7cd2-9ce0-0baac6d235ed`.

- Allow clicked in phone-sized Chrome, followed immediately by tag `591715f901f4ffcfa96adacb8372617806562842caa1aa20dad8543304e5b987` at `2026-10-31T21:21:34.040Z`.
- Threaded answer `690442f43cb4025d19d37c5b4078dbdd59dca7ab84842ed05b380d37733a62e8` at `2026-10-31T21:21:39.792Z`, from `@codexstockfinal`, text `CODEX_CLEAN_FINAL_ACK`.
- [Final native transcript](codex-clean/final-native.txt), [Room messages](codex-clean/room-messages.json), [first independent run](codex-clean/first-native.txt). Native transcript extracts omit internal reasoning and tooling schemas; private sign-in links are redacted. Exact native approval menus are retained as separate terminal captures.

## Chosen fix and silent-path limit

Beeline retains only its own content-pinned hook trust through Codex’s official config API. That removes the separate hook-trust prompt. The API does not grant a sandboxed command access to user config or the network. The clean run proves both restrictions block setup before that API can help. Moving state into the workspace cannot grant user-hook access and did not remove the network denial. No native permission bypass or silent mutation of Codex’s permission policy is shipped.

The permitted fallback is the single plain Codex sentence on Allow, naming the native one-time command approval. Documentation describes the initial policy/menu limitation separately. The strict untouched initial-policy path remains unavailable on this Codex installation; reviewers must assess that explicit limitation before merging.

## Allow screenshots

Only the added consent paragraph changes. The before fixture is the same Codex Allow page with the extra prompt sentence removed. Full-page Chrome captures use the server's fonts and actual renderer.

| | Bone phone | Obsidian phone | Bone web | Obsidian web |
| --- | --- | --- | --- | --- |
| Before | [view](codex-clean/before-bone-phone.png) | [view](codex-clean/before-obsidian-phone.png) | [view](codex-clean/before-bone-web.png) | [view](codex-clean/before-obsidian-web.png) |
| Codex prompt disclosure | [view](codex-clean/after-codex-bone-phone.png) | [view](codex-clean/after-codex-obsidian-phone.png) | [view](codex-clean/after-codex-bone-web.png) | [view](codex-clean/after-codex-obsidian-web.png) |

Validation: full Rooms MCP HTTP suite passed (113); root typecheck passed, including mobile and scripts; whitespace check passed. Both proof members were disconnected with session leave and their native sessions closed after capture.
