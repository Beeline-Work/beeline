# Google preview acceptance (brief revision 4)

This feature request is not a defect report. The screenshot pair uses an isolated
PGlite-backed mounted auth service and the real Expo web app, in Trusty Squire's
Chrome. No production configuration was changed and no live OAuth/device
acceptance is claimed.

## Web demonstration

1. Run `node --import tsx .verification/google-preview/fixture.mts`.
2. In `apps/mobile`, run
   `CI=1 EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:4319 npx expo start --web --port 8089 --max-workers 2`.
3. Open `http://localhost:8089/beeline/onboarding` in a fresh browser.
   `without-preview.png` shows GitHub alone, with Google hidden even though the
   service's master switch is on. The production-default master-off case is
   separately asserted by the mounted HTTP matrix.
4. Open `http://localhost:8089/?google_preview=` followed by 43 lowercase `p`
   characters. This is a public synthetic fixture value, not a production secret.
   The app removes the query and routes to onboarding. `with-preview.png` shows
   GitHub first with Recommended and Google second. Revisiting the token-free
   onboarding URL in that browser preserves enrollment.

The browser used the real cross-origin fetch, including its custom-header
preflight. The mounted HTTP tests separately pin the configured production web
origin, `Vary: Origin`, and denial of CORS permission to an unrelated origin.

## Before-merge evidence map

Paths below are under `apps/server/src` unless specified. These are isolated
integration proofs, with fixture provider grants/tokens. Test names identify
the assertions; live cloning, pushes, consent and recordings remain after merge.

| Edge | Integration coverage |
| --- | --- |
| E1 | `google-workspace-journey.test.ts`: Google Workspace, general and Room creation; `monolith-auth.test.ts`: exchange/profile; `free-agents.test.ts`: real handle in Beebee hello, cards on/off |
| E2 | `google-workspace-journey.test.ts`: Google invite redemption (client round-trip device proof remains live acceptance) |
| E3 | `monolith-auth.test.ts`, `auth.test.ts`: same subject and edited profile preserved |
| E4 | `monolith-auth.test.ts`: card → bind/install → repo selection → corner and Room token |
| E5 | `google-workspace-journey.test.ts`: existing org ownership with admin true/false; mounted callback verifies token access |
| E6 | `monolith-auth.test.ts`: cancel/failure leaves no partial links |
| E7 | `monolith-auth.test.ts`: another identity's GitHub subject rejected |
| E8 | `monolith-auth.test.ts`: shared bind/install and return path; existing mobile installation/callback tests cover callers |
| E9 | `google-workspace-journey.test.ts`: read-only owner-naming card, denied install |
| E10 | `google-workspace-journey.test.ts`: member corner plus exact Room grant, no member GitHub link |
| E11 | `google-workspace-journey.test.ts`: owner merge yes and member rejection |
| E12 | `google-workspace-journey.test.ts`: switch lists only viewer installations |
| E13 | `auth.test.ts`, `monolith-auth.test.ts`: explicit link, either provider resumes same identity |
| E14 | `auth.test.ts`: same subject across providers stays separate |
| E15 | `monolith-auth.test.ts`: stale reconnect, profile preservation and account mismatch |
| E16 | `auth.test.ts`: imported names, collision suffixes, reserved handles and length; `YouStep.test.tsx`: editable handle |
| E17 | `google-workspace-journey.test.ts`: provider links and token deleted |
| E18 | `google-workspace-journey.test.ts`: review identity denied |
| E19 | `repository-onboarding.test.ts`: identity-id eligibility while enabled |
| E20 | `repository-onboarding.test.ts`, `onboarding-rollout.test.ts`: flag-off refusal |
| E21 | `google-workspace-journey.test.ts`: pairing without GitHub |
| E22 | `monolith-auth.test.ts`, `server-cors.regression-1.test.ts`: recovery and configured-origin CORS |
| E23 | `monolith-auth.test.ts`: correct preview header, unlisted verified subject, 401 and no new provider identity; mobile `monolith-session.test.ts`: visible explanation, no session accepted |

Preview discovery's mounted HTTP matrix covers default-off, master-off, no
header, wrong header, right header and everyone-on. Client tests cover web URL
removal, persistence, cold/warm native links, desktop routing, malformed and
duplicate tokens. Preview enrollment never bypasses the subject allow list.

Unchanged #2668 tests: `apps/auth/src/server-github-onboarding.test.ts` (flag on
and off, install callback), `apps/server/src/free-agents.test.ts` (runtime guide
and invited-user behavior), and `apps/body/src/read-only-mcp.onboarding.test.ts`
(card discovery). The regular OAuth route tests also pass.

## After merge

Through Niglet, obtain the authorized staged configuration and next release.
Then post three consecutive production Android Google-owner runs ending in a
merged test PR, real iOS E1/E3 recordings, the production GitHub walkthrough,
and real-token existing-org admin evidence. Keep everyone-on unset pending
lunchboxfortwo's separate decision.
