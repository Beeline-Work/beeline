# Tray: one layout for every item

Reproduction R1: open the Tray with a saved message containing `**bold**` and an
agent's pending Trusty Squire sign-in card. Before: the saved row reads
`SAVED 4d`, puts the corner on top, shows `OPEN` and the raw `**`, and the
sign-in reads "Luna needs you to sign in to / Sign in to Trusty Squire?".
The same fixture also holds a Trusty Squire approval (`Review` link), a
passkey approval, a command grant (No / Once / Always) and the chat's
"Connect Trusty Squire" card.

## How it was run

- Server: `apps/server/src/index.ts` from `main` (fe39a63) for before and from
  this branch for after, against a disposable pgvector PostgreSQL 16 container,
  signed in through the local review link (`kit/server.sh`).
- Fixture: `kit/seed.mjs` writes the cards the way the server stores them (the
  sign-in card carries `name: 'Trusty Squire'` and its stored ask
  `Sign in to Trusty Squire?`).
- Web: `npx expo export --platform web` of each side, captured at 1280×900,
  device scale 2, in Bone and Obsidian (`kit/capture-web.mjs`).
- Android: an x86_64 release APK of each side (`kit/build.sh`) on the `dmproof`
  emulator (API 35), reaching the server through `adb reverse`
  (`kit/capture-android3.sh`). This helper could not open `/dev/kvm`, so the
  emulator ran without acceleration; screenshots are slow but are of the real
  app.

## Results

| | Before | After |
| --- | --- | --- |
| Saved age | `SAVED 4d` | `4d` |
| Saved action | `OPEN >` under every row | none; the row opens on tap |
| Saved order | corner, author (gold), text | author and age, quoted text, corner |
| Saved bold | raw `**Inscriptions…**` | **Inscriptions…** in bold |
| Sign-in | "needs you to sign in to Sign in to Trusty Squire?" | "needs you to sign in to Trusty Squire" |
| Squire approval | gold `Review ↗` link at the left | primary `Approve ↗` button at the right |
| Passkey approval | gold `Use passkey ↗` link at the left | primary `Use passkey ↗` button at the right |
| Grant | No / Once / Always on the right | unchanged |
| Chat Connect card | button at the left | button at the right |

- `web-tray-*.png`, `web-actions-*.png`, `web-chat-*.png`: web, before and after.
- `android-bone.png`: the Android Tray (top, scrolled, Saved) and the #general
  Connect card, before and after. `android-obsidian.png`: the same Tray top,
  Saved and Connect card in Obsidian.
