# Starter onboarding proof

The Android images render the built PhoneService snapshots using the existing native TranscriptCard and IdentityMark components in the surface proof app. They show the approved banter/hello/job choices and a preview with Post/Cancel. They do not demonstrate real sign-up, model-driven clip drafting, a Luna review of that clip, or a public YouTube upload.

Built service proofs:

- `node --import tsx scripts/prove-two-agent-onboarding.mjs`: creates the starter team, sends fixture model responses through shared proxy admission and settlement, plays timed messages, reads the resulting Room, and exercises repository choice, preview/Post gating and composer routing.
- `node --import tsx scripts/prove-onboarding-welcome.mjs`: human command through the built onboarding MCP tool and daemon HTTP adapter, asynchronous rerun, phone-read hello/choices and repository card. Uses isolated PGlite and the model-unavailable fallback.
- `scripts/prove-starter-banter.mjs`: live generation harness with an external sealed-credential controller. Requests and replies go through a local file bridge; proxy allowance settlement remains active. Live exchanges and measured usage are in [the evidence log](../starter-onboarding-banter.md).

Acceptance still required before review: a real preview/staging sign-up followed by the complete Android user paths, and a real clip reviewed and posted publicly to a dedicated test channel, with matching file size and successful processing status. The connected Composio channel and the owner's browser channel switcher expose the public @usebeeline channel; the other browser account has no channel. No test clip was published to @usebeeline.
