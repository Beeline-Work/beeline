# R-MCP-DEFAULT-PICTURES

Reproduced with the built server's real register → authorize → GitHub sign-in → consent path. The upstream GitHub identity provider is synthetic; the database, OAuth handlers, member creation, MCP calls and avatar HTTP route are real. Production sign-in was not used because approving it would change real memberships.

`grok-bot-{before,after}-{bone,obsidian}-{phone,web}.png` and `muse-…` show the same registration data, with phone width 390 and web width 1280. Before: Cursor/C and Muse's app squiggle. After: Grok Bot/face and Muse sheep in both the header and Joins as. Baseline screenshots use HEAD's original OAuth/logo/member modules transpiled into the built fixture; after screenshots use the new build. No page styles were altered.

After Allow, the proof exchanges the grant, calls set_profile with a name only (Firstmate/Muse), sends a Room message through MCP, reads the created member, and verifies that its avatar route returns WebP. `members.json` contains only these synthetic identities. `room-bylines-after-bone-phone.png` renders those exact served pictures in the production `LedgerBylineView`/`IdentityMark` components through the app's Expo web runtime. Native Android was not used (no device attached); this is the narrow app-component stand-in, not a production Room capture.

Run:

```sh
npm run build -w @beeline/server
MCP_PROOF_PORT=19783 node --import tsx scripts/prove-rooms-mcp.mjs --serve
# In another terminal (point MCP_BROWSER_PLAYWRIGHT at an installed playwright-core module if needed):
node scripts/prove-mcp-default-pictures.mjs
cd apps/mobile/mcp-avatar-proof
../node_modules/.bin/expo start --web --port 19784
```

Open the proof at localhost:19784 with the fixture still running. Capture it with `node scripts/prove-mcp-default-pictures.mjs --room-bylines` from the repository root. The mobile proof uses production byline components and only stubs native/platform dependencies through the existing notice-style proof adapters.

## Registration evidence and dry run

Production was queried read-only on 2026-10-31. Both Firstmate clients identify as Cursor and have redirects `https://www.cursor.com/agents/mcp/oauth/callback` and `http://localhost:8787/callback` (auth `none`, no supplied logo). Cursor desktop instead uses `cursor://anysphere.cursor-mcp/oauth/callback` (`client_secret_post`); the other Cursor web registration uses `https://cursor.com/agents/oauth/callback` (`none`). Ruby approved matching the first exact URL, only when the name is Cursor. All three shapes have HTTP regression coverage. Registration data is retained verbatim; display normalization happens when reading consent and creating member defaults.

No Dots/ChatGPT production registrations exist. Dots/OpenAI Dots get the bundled approved yellow demo-dot stand-in by name. Codex is never inferred to mean Dots.

Repeated dry run after applying the name rule (no production writes):

| App | Replaceable default pictures | Protected pictures | Missing pictures |
| --- | ---: | ---: | ---: |
| Grok Bot | 0 | 1 | 1 |
| Meta Muse | 0 | 1 | 0 |
| Pidoong | 0 | 0 | 1 |
| Total | 0 | 2 | 2 |

The missing Grok Bot picture gains the bundled default. Pidoong sent no logo and has no known default, so its missing picture stays a letter. Firstmate's set_profile picture and Muse's legacy custom picture (`mcp-set-profile-hotfix`) remain untouched. The migration runs once on deployment; this work did not apply it to production.
