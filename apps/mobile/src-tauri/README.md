# Beeline desktop shell (Tauri)

The desktop app is the Expo **web** bundle in a native window. There is no
second client: `expo export --platform web` produces `apps/mobile/dist`, and
Tauri wraps it. Everything a user sees is the TypeScript in `sources/`; Rust
owns the native window, plugins, and the OS credential-store commands used for
monolith session refresh tokens.

## The three configurations

`tauri.conf.json` is the production configuration and the base for the other
two — the Tauri CLI merges a `--config` file over it, so the variants carry
only what differs. Each has its own bundle identifier, which is what lets a
tester keep all three installed side by side without them sharing a webview
data directory.

| Script                           | Config                    | Product name    | Identifier                       |
| -------------------------------- | ------------------------- | --------------- | -------------------------------- |
| `npm run tauri:dev`              | `tauri.dev.conf.json`     | Beeline Dev     | `app.usebeeline.desktop.dev`     |
| `npm run tauri:build:dev`        | `tauri.dev.conf.json`     | Beeline Dev     | `app.usebeeline.desktop.dev`     |
| `npm run tauri:build:preview`    | `tauri.preview.conf.json` | Beeline Preview | `app.usebeeline.desktop.preview` |
| `npm run tauri:build:production` | `tauri.conf.json`         | Beeline         | `app.usebeeline.desktop`         |

`tauri.dev.conf.json` and `tauri.preview.conf.json` restate the whole window
object rather than one field of it: the CLI merges objects but _replaces_
arrays, and `app.windows` is an array.

The one behavioural difference between preview and production is the frontend
export: production exports with `NODE_ENV=production`, which is what
`app.config.js` reads to turn console logging off (`consoleLoggingDefault`).
Preview keeps the logs. `dev` also builds a smaller set of bundle targets,
since nobody ships a dev build through an installer.

The shipped version comes from `apps/mobile/package.json` via
`"version": "../package.json"`, so a desktop build carries the same release
version as the phone build from the same commit.

## Capabilities

`capabilities/default.json` is the whole permission surface. Beyond
`core:default` it grants exactly what the client calls today:

- `core:window:allow-start-dragging` and `core:window:allow-internal-toggle-maximize`
  — `sources/hooks/useTauriDrag.ts` invokes both to drag and double-click-zoom
  the frameless window by its header strip.
- `core:webview:allow-set-webview-zoom` — `sources/hooks/useTauriZoom.ts` uses
  the native zoom so the layout viewport really changes and responsive
  breakpoints react.
- `opener:default` — external links leave the app in the user's browser.
- `deep-link:default` — the external browser returns an allowlisted OAuth
  callback to the existing app instance.
- `http:default`, scoped to the Beeline hosts plus loopback for a self-hosted
  server. The scope is an allowlist: a new host has to be added here before
  the plugin will fetch it.

The window is frameless-on-macOS (`titleBarStyle: "Overlay"`,
`hiddenTitle: true`), which is why `SidebarNavigator.tsx` insets its header by
the width of the traffic lights.

## Session storage

The Expo web bundle has no `expo-secure-store` backend. In Tauri,
`sources/auth/monolith-secure-storage.ts` routes the two monolith session keys
to allowlisted Rust commands instead. The shell stores them in the Linux
kernel keyring, macOS Keychain, or Windows Credential Manager. Android and iOS
continue to use Expo SecureStore unchanged; browser `localStorage` never holds
these session credentials.

The shell registers the existing `beeline://` callback scheme. Linux and
Windows forward a second launch into the running instance; AppImages also
register their absolute path at startup because they have no installer hook.

## Icons

`icons/` is generated, not hand-drawn. It is derived from the single source of
app identity, `sources/assets/images/icon.png`:

```
npm run tauri:icons         # rewrite icons/
npm run tauri:icons:check   # fail if they drift; the DESKTOP ICONS CI gate
```

The script uses only node's `zlib`, so refreshing an icon does not require the
Rust toolchain that `tauri icon` would.

## Crate versions are tied to the JS packages

The Tauri CLI refuses to build when a Rust crate and its JS counterpart differ
in minor version, so `Cargo.toml` tracks `apps/mobile/package.json` rather than
crates.io HEAD: `tauri` follows `@tauri-apps/api` (pinned at 2.9.1), and both
plugin crates follow their `@tauri-apps/plugin-*` packages (2.5.x). Moving a
crate minor means moving its JS package in the same commit; `@tauri-apps/api`
is pinned exactly, which is the client's call to change, not the shell's.

## Building locally

Needs the Rust toolchain plus each platform's webview development packages
(see <https://tauri.app/start/prerequisites/>). From `apps/mobile`:

```
npm ci
npm run tauri:build:production
```

`Cargo.lock` is committed: a desktop build handed to a tester should be
reproducible, and it is also the cache key the CI lane uses. The lane that
builds all three platforms is `.github/workflows/desktop.yml`.
