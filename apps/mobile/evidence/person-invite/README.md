# Reproduction 1: retain a person invite when sharing is unavailable

Production web Members → Add people produced “Share is not supported in this browser” and no invite link (Squire session 040b8cc1-b56c-48e4-b93c-73936e8009ed).

The source-derived handler tests execute each real invite callback with a fixture invite service. On origin/main 55a3cbe42dd8ed2361692eb320dae35c58f1cdd2, both failed behaviorally: one link was minted, but no fallback received it. Restoring the draft made both pass.

The browser stand-in bundles those same callbacks, React Native Web and the actual PersonInviteSheet. Only the invite service, modal mounting and native bridges are substituted. Chrome has navigator.share removed. Both entry points render the existing URL, Copy and email input in Bone and Obsidian. It is not an authenticated full-app or native share-sheet proof. Screenshots are from this stand-in.

Run from apps/mobile:

```
npx vitest run sources/buzz/invite-handler.test.ts sources/buzz/share-person-invite.test.ts sources/buzz/person-invite.browser.test.ts
INVITE_BASELINE=1 npx vitest run sources/buzz/person-invite.browser.test.ts
```

The baseline browser run is expected to fail all four cases (no URL, Copy or email); the normal run passes them. The three helper cases cover absent sharing, successful sharing and rejected sharing.

Other requested investigations remain outside this patch: repeat-clicking #beeline in the production browser stayed in the room; Room actions opened the expected menu (Repository, Reviewer, Members, Schedules, Delete, Leave). A second browser, new-signup duplicate-join reproduction and cold-login font reproduction remain outstanding. No changes to those behaviors are claimed. Revision 3 removed name, timer and timezone work.

The footer spacing regression measured zero separation before the correction and now requires at least the existing large spacing token (24px) between Email invite and Cancel. All four browser cases pass. Email invite is intentionally disabled until the email field contains text. Updated after screenshots include this spacing correction.
