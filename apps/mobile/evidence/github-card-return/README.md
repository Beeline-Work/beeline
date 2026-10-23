# Repository card return and workspace landing

## Reproduction R-GITHUB-CARD

Return a failed GitHub connection to a Room with two repository cards. Before:
all cards receive the same error, show conflicting connection actions, and keep
the error in the URL. After: only the initiating card shows inline danger text
and one secondary Try again action; consuming the error clears its query
parameter while preserving the repository picker and installation result.

`RepositoryOnboardingCard.test.tsx` renders both cards, consumes the return and
remounts the initiating card. The regression fails against the original code
and passes with this change. The native installation-return success test also
passes.

The Android Chrome screenshots use the actual RepositoryOnboardingCard and
TranscriptCard, built with `node apps/mobile/scripts/render-github-card-proof.mjs
<output>`. Navigation and phone operations are fixture adapters, not production
OAuth. Open `?repositoryPicker=card-one&githubConnectionError=github_account_already_linked`
for the failure and the bare URL for normal cards. Add `theme=bone` for Bone.
These screenshots establish layout on Android Chrome, not native sign-in.

Native screenshots (`native-*`) use a locally built debug APK on the isolated
API 36 emulator, with the actual native card components, theme and fonts. The
native fixture source is retained in `proof-kit/`; it replaces only navigation,
eligibility and phone operations. The same fixture was captured against the
original card/TranscriptCard and against the fix. These establish native layout,
not an end-to-end OAuth session. No release was dispatched.

## Reproduction R-GITHUB-LANDING

A confirmed nonempty workspace response arrives before its subscribed surface
snapshot. The original channels route combines a confirmed boolean with a
missing snapshot and reads its count as zero, redirecting to community.
`channels.live.test.tsx` reproduces this ordering through the actual route
component and records the wrong router call. It fails against the original code
and passes when the confirmed count comes from the same response. Existing tests
still redirect confirmed empty accounts to community.

This route-component reproduction is the closest stand-in for the reported
production sign-in flash; it does not establish a filmed production sign-in.

## GitHub ownership

Read-only production SQL found GitHub login lunchboxfortwo, subject 269599412,
linked to Beeline identity
`34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334`,
the owner identity in the approved brief. No retained GitHub auth flow exists
for that identity, so the initiating identity of the reported failure is
unknown. The mounted auth callback test now explicitly reconnects that same
identity and succeeds with installed=1. The existing conflict guard already
allows this; no server token-flow or identity-ownership change is needed.

## Acceptance gaps

Reviewer-bypass browser verification remains pending: connector discovery found
the vaulted review link; sealed browser-fill returned unsupported_credential_type;
Squire drive could not consume that link and observed an existing Bento Maker
session instead. No production repository actions were taken. A browser handoff
is needed to sign in with the review link without exposing its secret.

The server refused recording these reproduction details in the brief because
its approval lookup requires a human Room message, while the inherited brief
cites the owner's DM. The approved scope remains revision 1; the reproduction
identifiers and evidence are recorded here and in the pull request.

## Validation

Root typecheck and shared UI component policy pass. Targeted mobile suites pass,
including live channels, card resume, workspace choice, calm lint and design
lint. The mounted auth callback reconnect test passes. Both R-GITHUB regressions
also fail against the original source. The native x86_64 debug APK builds with
two Gradle workers and a bounded Java heap. Proof-only app entry and Metro
resolver changes were restored before final validation.
