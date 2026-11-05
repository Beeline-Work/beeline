# Linux desktop updater proof — 2026-11-05

The production updater endpoint and published signatures work for the old
installer. Release `v0.1.142` carries desktop `0.2.127`; release `v0.1.162`
advances it to `0.2.128`. The unified release tag is independent of the native
version and is not used in Tauri's version comparison.

The old frontend checks at startup and foreground activation. Current source
checks at startup and socket reconnection. Neither scheduled another check in
an app that stayed open with the same connection. The change adds a check every
minute to production desktops, retaining the existing busy-route/install owner.
Native phones and preview builds do not get a timer.

The Settings footer reads `extra.app.releaseVersion` from Expo config. Desktop
CI supplied the release SHA but omitted `EXPO_PUBLIC_BEELINE_RELEASE_VERSION`;
the workflow now supplies its existing `release_version` input to the export.

## Published old-build installation

Downloaded both official Linux AppImages, their published manifests and release
records with `gh-axi release download`. The old AppImage and its embedded
updater endpoint, public key, version comparison, frontend and installer code
were unchanged. Launched a disposable copy of the old AppImage with
`APPIMAGE_EXTRACT_AND_RUN=1` under private Xvfb, D-Bus, HOME/XDG paths and a
new kernel session keyring. A launcher denied persistent-keyring lookup so the
proof could not read the host user's credentials. No sign-in was needed.

A scratch LD_PRELOAD probe added a document-end script to report native
`plugin:app|version`. It also requested an explicit check after 20 seconds;
the automatic startup update and relaunch had already completed before that
request. The display and D-Bus session stayed alive across relaunch.

The rig's DNS answer for `github.com` (`140.82.112.4`) timed out. A task-local
CONNECT tunnel routed `github.com:443` to another GitHub address
(`140.82.114.4`) and passed the release-assets host through normally. TLS stayed
end-to-end, with normal certificate verification. Neither manifest contents nor
payloads were rewritten. This proves installation against the real published
manifest; it does not prove the unreachable address was repaired or establish
which requests the separate release-walkthrough session made.

Observed native probe output across the automatic update:

```text
PROOF {"started":true}
PROOF {"nativeVersion":"0.2.127"}
PROOF {"started":true}
PROOF {"nativeVersion":"0.2.128"}
PROOF {"nativeVersion":"0.2.128"}
PROOF {"manualCheck":"no update"}
```

| File | SHA-256 |
| --- | --- |
| Official old AppImage (`v0.1.142`) | `90341a89ce72550d653cfae30c1ac429ed52fa2d8df118ce834e0023c2547e57` |
| Official new AppImage (`v0.1.162`) | `32a6c907e55e4a8e6c2e7402353a3440400a00f9e7df08a6a29c6098d9dbea13` |
| Old installation after automatic update | `32a6c907e55e4a8e6c2e7402353a3440400a00f9e7df08a6a29c6098d9dbea13` |

No updater signing key or release secret was accessed or changed.

## Source validation

- `apps/mobile`: `./node_modules/.bin/vitest run sources/hooks/useUpdates.test.ts`.
  The new late-publication regression fails with the timer removed, then passes
  with it restored. It verifies discovery/install/relaunch without a reconnect
  and timer cleanup; native/preview cases verify no periodic checks.
- Root `npm run typecheck` and `npm run lint:workflow-paths` pass.
- `EXPO_PUBLIC_BEELINE_RELEASE_VERSION=v0.1.162 ./node_modules/.bin/expo config --json`
  from `apps/mobile` produces `extra.app.releaseVersion: "v0.1.162"`.
  The desktop workflow's export step supplies that variable from its existing
  release input. A new signed release build was not produced locally.
