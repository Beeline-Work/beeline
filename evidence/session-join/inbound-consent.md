# SESSION-JOIN-INBOUND-1

Reproduction SESSION-JOIN-INBOUND-1: in live Claude Code (2.1.311), start with `--dangerously-skip-permissions`, run “Join my Beeline Room”, sign in and Allow, then tag the joined member from the Room → Claude holds the confirmation and the tag instead of starting a turn.

The target is the installed interactive Claude Code. The Beeline server is built production code on loopback (`scripts/prove-session-join.mjs`), with a synthetic GitHub identity provider. This avoids changing production Room membership or using a real person's OAuth login for a test.

## Baseline, 2026-10-31

- Built baseline: `57db6b8b6`.
- Live session: `835840db-ef59-482a-a5c0-c67e1fa6ac92`.
- Pasted: `Join my Beeline Room: http://127.0.0.1:47123/room` (the session used the local baseline bundle in place of npx).
- The proof phone followed the printed sign-in link, signed in through the synthetic GitHub provider, and submitted Allow. The connected page returned success.
- At `20:00:30Z`, the owner tagged the member asking it to answer `BASELINE_ACK` in the Room (message `253c37b70cbf4845136ca5e364da4ab7c060bed0087ce2d2fb57cea0c1503443`).
- After correcting the proof's overly long temporary Unix socket path, the bridge posted the tag at `20:01:02Z`.
- Interactive Claude displayed: “not delivered to Claude (2 held). The sender did not attest its permission mode and this session bypasses prompts.” It offered a manual message approval or setting `crossSessionInbound` to `accept`.
- Reading `/proof/messages` showed only the owner's tag, with no member reply. No held-message approval was given.

The initial long-path bridge failure is tracked separately as feedback `fb_4aacc25341e5290fac018d3b`; the proof uses a short temporary state path thereafter.

## Passing live paths

All paths use real installed interactive coding sessions and the built Beeline server. The local bundle replaces the published npx bundle so these runs exercise this change before release. The only external-service stand-in is the synthetic GitHub provider; production accounts and Room membership are untouched. Allow was also clicked in real Chrome at a phone viewport, through the actual sign-in/consent pages, for each final row below. Nothing was typed into the coding session after Allow to make it wake.

| Live path | Native conversation | Owner tag → threaded Room answer |
| --- | --- | --- |
| Already-open Claude Code (skip-permissions), fallback consent shown | `835840db-ef59-482a-a5c0-c67e1fa6ac92` | `20:23:50.680Z` → `20:24:02.995Z`, `CLAUDE_BROWSER_ACK` |
| New Claude Code (skip-permissions), in-session MCP server | `f55c5e2a-a4b8-4e15-b889-589de7c29bc5` | `20:22:55.655Z` → `20:23:01.865Z`, `CLAUDE_MAIN_LATEST_ACK` |
| Codex, Beeline hook trusted without a trust prompt | `01a19396-2359-7be2-b5cb-b92dbcba8db1` | `20:24:35.640Z` → `20:24:42.496Z`, `CODEX_BROWSER_ACK` |

Native extracts: [already-open Claude](inbound-fixed/claude-already-open.txt), [new Claude on the final build](inbound-fixed/claude-main-latest.txt), [Codex](inbound-fixed/codex-trusted.txt). Exact tag/reply IDs, authors, timestamps and thread parents: [Room messages](inbound-fixed/room-messages.json). Sign-in links and private home paths are redacted from the extracts.

For the new Claude path, Beeline's MCP child was registered before join. Leaving the previous fallback session restored `crossSessionInbound` to **absent** before the new session's Allow and tag. Reading the setting immediately before that tag still returned `undefined`; the new session answered through its own MCP child without restoring `accept`. The earlier new-session run is also retained in [its native extract](inbound-fixed/claude-new-session.txt).

The final fallback build additionally passed a tag posted immediately after Allow, before the finisher had registered the local joined session: `20:20:39.732Z` → `20:20:46.455Z`, `CLAUDE_FAST_ACK`. The first mentions page is now queued rather than discarded. The fallback gives Claude's settings watcher time to load consent before posting the confirmation or tag; no held-message approval was supplied.

Claude version: (2.1.311). Codex CLI: (0.165.0); its managed app server reported (0.166.0) during the final live run. Codex used full access **before** join so it could write its user config and reach the loopback proof server. No hook-trust bypass flag was used. An earlier default-sandbox attempt could not complete the background user-config setup; this evidence does not claim that initial host access is unnecessary in a restricted sandbox.

Clean-first-join follow-up: [SESSION-JOIN-CODEX-CLEAN-1](codex-clean.md) records fresh homes without prior config allowances, the exact one-time native prompt, successful post-Allow wake, and the remaining initial native permission-preset limitation. It supersedes the full-access-only caveat above.

## Codex file trust investigation

An isolated Codex (0.165.0) app-server run listed Beeline's hook as `untrusted`, returned its normalized `currentHash`, and accepted a `config/batchWrite` of just `hooks.state.<Beeline hook key>.trusted_hash`. Listing again returned `trusted`. No session, model request or credential was needed for that investigation. The live join then printed “Trusted only Beeline’s SessionStart hook, pinned to its current Codex hash.” and answered its tags without a hook-trust prompt. A second live run used a different bundle path, changing the hook declaration hash, and also completed automatic trust after Allow.

The implementation asks Codex to calculate and persist its own hash. It validates the exact user hook file, command, event, matcher, timeout, numeric hook key and supported hash shape. Unknown metadata or APIs retain the prompt: open `/hooks` and trust only Beeline. It never requests trust for another hook. [Codex's normalized hook hashing](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/hooks/src/engine/discovery.rs) and [config write protocol](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/app-server-protocol/schema/typescript/v2/ConfigBatchWriteParams.ts) are the primary source references.

The live investigation also found that one shared Codex app-server can keep several rollout files open. The old scanner took only the first, which could move delivery to an older conversation. The final build scans all open rollouts and prefers the exact thread ID. The final Room replies above are present in that same native thread's transcript.

## Consent captures

[Standard consent HTML](inbound-fixed/after-standard.html) and [fallback consent HTML](inbound-fixed/after-fallback.html) came from the built server's actual Allow renderer. Hidden flow identifiers are scrubbed. `before.html` removes only the added consent paragraph from the same rendered fixture, keeping the comparison's content and layout stable. Captures use Chrome with the server's bundled fonts, full-page screenshots, a phone viewport (390 × 844) and desktop viewport (1440 × 1000). They are browser viewport captures, not native app screenshots.

| Capture | Bone phone | Obsidian phone | Bone web | Obsidian web |
| --- | --- | --- | --- | --- |
| Before | [view](inbound-fixed/before-bone-phone.png) | [view](inbound-fixed/before-obsidian-phone.png) | [view](inbound-fixed/before-bone-web.png) | [view](inbound-fixed/before-obsidian-web.png) |
| Standard | [view](inbound-fixed/after-standard-bone-phone.png) | [view](inbound-fixed/after-standard-obsidian-phone.png) | [view](inbound-fixed/after-standard-bone-web.png) | [view](inbound-fixed/after-standard-obsidian-web.png) |
| Fallback | [view](inbound-fixed/after-fallback-bone-phone.png) | [view](inbound-fixed/after-fallback-obsidian-phone.png) | [view](inbound-fixed/after-fallback-bone-web.png) | [view](inbound-fixed/after-fallback-obsidian-web.png) |

## Regression coverage and limits

Body session-join tests cover additive/idempotent MCP setup, own-token socket delivery, data framing on both Claude paths, normal/server-backed sessions leaving inbound unchanged, consent cancellation, managed hold with byte-identical app files, two-session restore (including another app), exact old values/absence, immediate-after-Allow tags, multi-thread Codex discovery and Beeline-only hash trust. Server tests render both consent variants through the full HTTP OAuth flow.

Validation passed: session-join tests (54), the full Rooms MCP HTTP suite (112), root typecheck including mobile/scripts, and the dead-code gate (no introduced findings). After the live proofs, the synthetic connections were left/revoked and the native proof sessions were closed. Reading the user inbound setting after cleanup returned `undefined` again.

OpenCode, Pi, Antigravity, Gemini CLI, Hermes and ZCode adapters were reviewed in `setup.ts`, `templates.ts`, `hook.ts` and `pull-apps.ts`. No new per-message hold or trust blocker was established for those paths, so they are unchanged. Their existing adapter regressions pass; this is not a live proof for those apps.

A Claude session switched into skip-permissions after joining can still hold outside messages when it has no in-session server. Project/flag tightening can also override the fallback. Managed `hold`/`refuse` is refused before app setup, rather than bypassed.
