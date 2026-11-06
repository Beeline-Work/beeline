# Lifecycle group nouns

Human approval: lunchboxfortwo's message `27434ce21957b65c1c6adcc886daa8fb9985c9e6978ca244c92a620b6dd62ab9`, approving Ruby's proposed wording in `05b54be259f25150e6c34f5f063e9f76028011c58ceee2e9acc726c332005051`.

This is a wording enhancement, not a defect report. The collapsed row names the first nonempty item of each group and omits the noun on subsequent states. Counting, order, and expanded lines are unchanged.

## Rendered proof

The captures render the real `NotificationLifecycleCard`, `LedgerDisclosure`, themes, and Space Grotesk font through Expo Metro and React Native Web. A temporary entry supplies a fixed run with three opened PRs, four merged PRs, twelve filed issues and twenty-eight closed issues. The before build uses the parent implementation; the after build uses this branch. The entry was removed after capture.

Playwright asserted the exact accessible summary and collapsed state, clicked the disclosure, and verified the remaining events control on both builds in both themes at desktop (1280 × 720) and phone (390 × 844) viewport sizes. Phone captures are browser viewport proofs, not Android device screenshots; `adb devices` listed no attached device.

| View | Before | After |
| --- | --- | --- |
| Web Bone | [Before](before-web-bone.png) | [After](after-web-bone.png) |
| Web Obsidian | [Before](before-web-obsidian.png) | [After](after-web-obsidian.png) |
| Phone width Bone | [Before](before-phone-bone.png) | [After](after-phone-bone.png) |
| Phone width Obsidian | [Before](before-phone-obsidian.png) | [After](after-phone-obsidian.png) |

The production browser signed in through GitHub and opened `#beeline`, where the existing collapsed row read `1 PR opened · 2 PRs merged · 9 issues filed`. The local full app starts, but production OAuth refuses its localhost callback with `native completion redirect is not allowed`. The rendered component is the closest local stand-in; production after-release proof remains outstanding.

## Checks

- Standard mobile Vitest command: `npm test --prefix apps/mobile -- --run sources/buzz/pr-lifecycle.test.ts` — all thirteen tests pass after building workspace dependencies.
- Mobile typecheck: `npm run typecheck --prefix apps/mobile` — passes after removing the temporary proof entry.
- Existing before-change regression evidence showed the new wording assertions failing; tests include all other lifecycle kinds and unchanged cases with no opened PRs.
- Full mobile suite and native device build were not run for this isolated formatter change.

## Download timeout follow-up

The original screenshot `29088.jpg` downloaded through Beeline's attachment read and opened successfully. Its size is 509953 bytes and SHA-256 is `7e46cb0b9d3a1eaf2aefa2601a49589149cfe1f90667215cb533eeb99cb611e5`, matching the message metadata. Ruby's recorded follow-up also reported a successful download after the helper update. No download code change was made because the current path succeeds.
