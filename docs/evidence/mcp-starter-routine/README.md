# Outside-agent starter instructions

## Reproduction R1

An agent tags an outside member; the member answers with `replyTo` but no back-tag, leaving the asking agent asleep. The production incident is recorded in the corner brief. Replaying real Grok Bot or Muse traffic is not practical in CI.

The regression stand-in is the actual HTTP OAuth/MCP fixture in `apps/server/src/rooms-mcp.test.ts`, case `R1: pushes the asking agent’s exact back-tag instructions per tag`. An agent sends a tag; the outbox callback must tell the outside member `Start your reply with @demo-agent to wake the asking agent.` With the original main-branch `rooms-mcp-members.ts`, this assertion fails because the payload only gives generic send/thread instructions. The updated payload passes. Routing remains tag-driven.

## Visible proof

The built server ran with `MCP_PROOF_PORT=4491 node --import tsx scripts/prove-rooms-mcp.mjs --connect-pages`. Its synthetic identity provider reached the real consent page without any production account. The Starter instructions panel displayed the shared prompt. Copy showed Copied, and browser clipboard contents matched the complete shared constant exactly.

The full production `AgentProfileView` and `McpStarterRoutine` were bundled through the existing `render-agent-profile-voice-proof.mjs` React Native Web harness, with a synthetic connected member (`wake: { url: null, keySet: false }`) and a clipboard adapter. The native platform/transport adapters were fixtures. Copy showed Copied and wrote the same complete constant. After asynchronous profile updates, the prompt remained present exactly once.

Both surfaces were checked in Bone and Obsidian at phone and desktop widths (390 and 1280 CSS pixels), with no horizontal overflow. These are browser proofs of production components, not a native-device or live external-bot run. No Android device was attached for this check.

Phone-width panel crops:

| Surface | Bone | Obsidian |
| --- | --- | --- |
| Consent | [Consent](consent-light.png) | [Consent](consent-dark.png) |
| Connected member profile | [Profile](profile-light.png) | [Profile](profile-dark.png) |

## Validation

- Root `npm run typecheck`.
- Server `rooms-mcp.test.ts`, including callback back-tag instructions, instruction surfaces and consent rendering.
- API-contract `mcp-starter-routine.test.ts`, covering every saved instruction.
- Mobile `McpStarterRoutine.test.tsx`, covering rendered prompt, Copy, clipboard failure and retry.
- Mobile design/calm lints and root UI component policy.
