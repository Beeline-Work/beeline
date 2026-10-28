# Starter onboarding proof

The Android images render the built PhoneService snapshots using the existing native TranscriptCard and IdentityMark components in the surface proof app. They show the approved banter/hello/job choices and a preview with Post/Cancel. They do not demonstrate real sign-up, model-driven clip drafting, a Luna review of that clip, or model-driven clip review. The separate real upload proof below verifies delivery.

Built service proofs:

- `node --import tsx scripts/prove-two-agent-onboarding.mjs`: creates the starter team, sends fixture model responses through shared proxy admission and settlement, plays timed messages, reads the resulting Room, and exercises repository choice, preview/Post gating and composer routing.
- `node --import tsx scripts/prove-onboarding-welcome.mjs`: human command through the built onboarding MCP tool and daemon HTTP adapter, asynchronous rerun, phone-read hello/choices and repository card. Uses isolated PGlite and the model-unavailable fallback.
- `scripts/prove-starter-banter.mjs`: live generation harness with an external sealed-credential controller. Requests and replies go through a local file bridge; proxy allowance settlement remains active. Live exchanges and measured usage are in [the evidence log](../starter-onboarding-banter.md).

## Acceptance under brief revision 3

There is no staging environment. Ruby accepts the built-service evidence above and owns a real Android sign-up after the owner’s release.

`npm run prove:starter-youtube` exercises the shipped visual preview → Post gate → Composio multipart upload path with an explicit real-upload opt-in. The owned vertical clip reached @usebeeline as unlisted video `tSeP7dxCqqI`. YouTube confirmed fileSize 7168, processingStatus succeeded and uploadStatus processed. The connector could not delete with its OAuth scope (403); the owner’s signed-in Studio session deleted it. The subsequent owner-authenticated API query returned HTTP 200 and no matching items. Nothing public went up. See [the upload and cleanup evidence](youtube-unlisted-acceptance.json).

Updated Android snapshots show “Pick a first job” and the actual clip frame, title and unlisted visibility above Post/Cancel. The same ChoiceVideoPreview component renders production and proof cards. The video_preview tool checks the clip and frame belong to the Room. Model-authored metadata and Luna’s clip review remain agent-driven behavior; the harness does not claim to demonstrate those model turns.

Approval repair — R-STARTER-VIDEO-APPROVAL: Speedy reproduced a YouTube job followed by an unrelated Room-message Post card, answered through PhoneService, authorizing upload without a video preview. The gate now selects only a video preview and compares the Room clip object, title, description and visibility to the multipart arguments before consuming approval. Unknown upload fields and alternate file representations are refused; the optional category is fixed to 22.

Run `node --import tsx scripts/prove-starter-video-approval.mjs` after building the server. This isolated built-service proof uses workspace creation, the YouTube job, actual Room choice cards and PhoneService answers. An unrelated Post and changes to each approved field reach no upload continuation; the exact preview/Post path reaches it once, and reuse is refused. The continuation is a counter stub, not an external upload. Existing real unlisted upload and deletion evidence above is preserved; no repeat external upload was made for this repair.
