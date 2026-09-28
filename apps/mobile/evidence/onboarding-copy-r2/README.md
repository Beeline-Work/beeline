# Onboarding copy and layout frames

These are 390×844 at 2× frames from the Expo web build of this branch, rendered by the real React Native app components in Bone mode and captured with `chrome-devtools-axi`. They are browser frames, not screenshots from the captain's physical phone.

| Frame | State shown |
| --- | --- |
| [Sign in](sign-in-bone.png) | Fresh browser profile on the real onboarding route; no account or GitHub callback. The sign-in copy and action are unchanged. |
| [You](you-bone.png) | The real `YouStep` component mounted in the app through a temporary local route, removed before commit. Its identity state is synthetic: handle `ada_lovelace`, seeded face art, and a selected owl. This demonstrates that the actual handle prop is substituted between the brass `@` and final ink period, with no name field, face label, or large preview. The backing component uses the same `faceStep.handle` value received after sign-in. |
| [Create or join](create-or-join-bone.png) | The real Workspace choice route after signing in to the disposable design-audit server through its review link. The seeded viewer is Alan and already has a Workspace; the new Create subtitle and absent existing-user paragraph and link are visible. No production or captain account was used. |

These frames were recaptured after rebasing on the shared ink-button theme. A native build and the captain's device remain the release verification gate.
