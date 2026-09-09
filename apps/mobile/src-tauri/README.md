# Beeline desktop shell (Tauri)

The desktop app is the Expo **web** bundle in a native window. There is no
second client: `expo export --platform web` produces `apps/mobile/dist`, and
Tauri wraps it. Everything a user sees is the TypeScript in `sources/`; the
Rust in `src/` opens the window and registers two plugins, nothing more.

## The three configurations

`tauri.conf.json` is the production configuration and the base for the other
two — the Tauri CLI merges a `--config` file over it, so the variants carry
only what differs. Each has its own bundle identifier, which is what lets a
tester keep all three installed side by side without them sharing a webview
data directory.

| Script | Config | Product name | Identifier |
| --- | --- | --- | --- |
| `npm run tauri:dev` | `tauri.dev.conf.json` | Beeline Dev | `app.usebeeline.desktop.dev` |
| `npm run tauri:build:dev` | `tauri.dev.conf.json` | Beeline Dev | `app.usebeeline.desktop.dev` |
| `npm run tauri:build:preview` | `tauri.preview.conf.json` | Beeline Preview | `app.usebeeline.desktop.preview` |
| `npm run tauri:build:production` | `tauri.conf.json` | Beeline | `app.usebeeline.desktop` |

`tauri.dev.conf.json` and `tauri.preview.conf.json` restate the whole window
object rather than one field of it: the CLI merges objects but *replaces*
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
- `http:default`, scoped to the Beeline hosts plus loopback for a self-hosted
  server. The scope is an allowlist: a new host has to be added here before
  the plugin will fetch it.

The window is frameless-on-macOS (`titleBarStyle: "Overlay"`,
`hiddenTitle: true`), which is why `SidebarNavigator.tsx` insets its header by
the width of the traffic lights.

## Icons

`icons/` is generated, not hand-drawn. It is derived from the single source of
app identity, `sources/assets/images/icon.png`:

```
npm run tauri:icons         # rewrite icons/
npm run tauri:icons:check   # fail if they drift; the DESKTOP ICONS CI gate
```

The script uses only node's `zlib`, so refreshing an icon does not require the
Rust toolchain that `tauri icon` would.

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
