# Validation

Verified on 2026-08-09 from a new `git clone --no-local` of commit `3316793` in a disposable
directory. Commands ran in the order below; every command returned exit code 0.

| Command | Result |
| --- | --- |
| `npm install` | 303 packages installed at repo root |
| `npx turbo run build` | 6/6 workspace builds passed, 0 cached |
| `npm install --prefix apps/mobile` | 1,646 mobile packages installed |
| `npm run typecheck` | 9/9 workspace tasks plus mobile TypeScript passed |
| `npm run typecheck --prefix apps/mobile` | Mobile TypeScript passed |
| `npm test` | 9/9 workspace test tasks passed |
| `npm test --prefix apps/mobile -- --run` | 97 files, 944 tests passed |

Additional release/emulator verification from the task worktree:

| Command/check | Result |
| --- | --- |
| `npm run apk:release` | Signed release APK built successfully (296 MiB) |
| APK metadata via `aapt dump badging` | Historical pre-rename package; rerun for `app.usebeeline.mobile` |
| Install and live flow on `buzzy_api36` | Passed; screenshots are in this directory |
