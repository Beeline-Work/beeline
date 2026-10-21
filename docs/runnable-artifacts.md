# Runnable HTML artifacts

Status: draft implementation. Web frame self-navigation remains a decision blocker; do not describe this as a completely offline browser.

An agent explicitly posts a single HTML file with `post_artifact({path, mime:"application/vnd.beeline.game+html"})`. Inline scripts and pointer/canvas games are supported. Ordinary `text/html` and SVG retain their existing inert validators and script-off transcript previews. Runnable cards also use the inert HTML preview; execution starts only after opening the viewer.

The current refusal is in Body's `artifact-validation.ts`: inert HTML rejects script elements and event handlers as well as external assets and submitting elements. The mobile `artifactWebViewProps` table disables scripts, web uses an empty iframe sandbox, and `wrapArtifactMarkup` adds a script-blocking CSP. These layers intentionally made self-contained visual mocks safe to preview in a conversation.

## Execution boundary

The authenticated app requests `/v1/media/<id>/play`. `ObjectService.runnableLink` checks the MIME and mints a ten-minute HMAC capability. No session token is embedded in the resulting game URL.

The dedicated `https://beeline-games.fly.dev` site serves `/play/<uuid>?expires=…&token=…`. `fly.dev` is a private public suffix; its game and server hostnames have different registrable domains, and the game also differs from `usebeeline.app`. `runnableOrigin` checks this using the public suffix list and rejects an application site or a non-HTTPS origin. `BEELINE_GAME_ORIGIN` can override the dedicated origin, provided its proxy configuration changes with it.

The credential-free game edge in `scripts/runnable-artifact-proxy.mjs` accepts GET game paths only. It forwards no caller cookies, authorization, or other headers; it fixes the backend Host to the game host and reaches `beeline-server.internal:8080`. The server branches before authentication or API routing and rejects every non-game path and WebSocket upgrade on that host. The edge refuses responses missing the sandbox policy, strips any Set-Cookie, follows no redirects, and caps buffered bodies at 25 MiB.

The server checks the capability, object MIME, and expiry before reading bytes from storage. Ordinary signed storage links serve runnable source as `text/plain`; they never provide a second, unsandboxed HTML execution path.

Each game response carries:

```
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'; sandbox allow-scripts
Permissions-Policy: camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), fullscreen=()
Referrer-Policy: no-referrer
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

The response sandbox makes the document's origin opaque even in a mobile top-level WebView. Cookie and storage access throws. The web iframe additionally grants only `allow-scripts`. Mobile has no onMessage or injected JavaScript, file access, DOM storage, shared-cookie synchronization, geolocation, automatic popup permission, or fullscreen video. Its navigation callback allows the game origin only. `originWhitelist=['*']` is deliberate: the library otherwise sends disallowed URLs to the OS through Linking before consulting the callback. The callback itself rejects other origins and schemes.

The app keeps Close outside game content. A renderer crash/termination unmounts the WebView and shows “Game stopped. Close and reopen it to try again.” Opening a new artifact or closing the viewer ends the current game.

## Mobile authentication

`monolith-session.ts` stores access and refresh tokens through `monolith-secure-storage.ts`: native uses Expo SecureStore; web uses the application's own origin storage. API requests carry Authorization bearer headers. Legacy native identity keys also use SecureStore in `buzz-identity-storage.ts`. Native sign-in uses Expo's external authentication browser rather than the artifact WebView. No Beeline API session cookie is installed by that flow in Android's WebView CookieManager.

The implementation does not enable Android incognito or clear its global cookie jar. The separate site, opaque response origin, denied network subresources, and absence of a native message bridge isolate the game from existing app secrets and any unrelated WebView cookies. No native runtime or config plugin changes are needed for the demonstrated Android path.

## Threat model

| Threat | Boundary and remaining limits |
| --- | --- |
| Session, cookie, or storage theft | No bearer reaches the game. Cross-site and opaque origins block app DOM, cookies, and storage. No native bridge exposes SecureStore. |
| API fetches or exfiltration through subresources | CSP blocks fetch, XHR, WebSocket, beacon, external scripts/styles/images, child frames, and workers. Data/blob images and inline canvas drawing remain available. |
| Phishing UI | Trusted viewer title and Close stay outside the content. The game cannot enter browser fullscreen, open popups, show sandboxed modal dialogs, or navigate the app. A malicious game can still draw deceptive text inside its own content; no sandbox can make authored text trustworthy. |
| Navigation | Web sandbox blocks top/parent navigation, popups, forms, and downloads. Mobile callback also rejects external self-navigation. **Web self-navigation can still make an outside network request; see the blocker below.** |
| Mining or infinite loops | CSP denies network pools and workers, but does not prohibit CPU work. Android renderer runs separately; the emulator proof demonstrates a trusted counter and Close remain usable during a real infinite loop. Close unmounts the WebView. This is termination by the user, not a CPU quota. |
| Camera, microphone, location | Opaque sandbox origin and response Permissions-Policy deny access. Native geolocation is disabled and iOS media-capture policy is deny. |
| Capability disclosure | Unguessable HMAC link, short expiry, no referrer, no shared cookies. Anyone given that link can read that artifact until expiry; there is no claim of protection against a recipient copying its contents. |

## Blocking web decision

`Reproduction HTML-GAME-NAV-1`: load the exact game response policy inside `sandbox="allow-scripts"`, then run `location.href='https://example.org'`. Chromium navigates the iframe to that external site while the trusted parent remains unchanged. `default-src` governs resource loading, not document self-navigation. See [the captured frame](evidence/runnable-artifacts/web-navigation-gap.png).

Thus the requested iframe boundary protects the app, its session, and API bearer, but it does not satisfy the absolute “no outside network” requirement. Adding a JavaScript override or an unsupported navigation CSP directive would not be a security boundary.

Decision needed: accept outside navigation confined to the opaque iframe while keeping network subresources, API fetches, and app navigation denied; or retain the absolute offline requirement and replace direct browser JavaScript with an interpreter/worker execution system with an explicit capability API. The latter is a different execution architecture and is not implemented here. Native scope does not resolve this web limitation.

## Hosting

A separate `beeline-games` Fly app was provisioned in the owner's existing organization. The edge is one 256 MiB shared-CPU Machine, autostart enabled and autostop to zero. Its root filesystem contains only the proxy script and the pinned Node runtime. It has no application credentials or database connection. No production server deployment, release workflow, or existing Machine was changed.

Before this PR's server code is released, a game path returns 503 because the backend lacks the mandatory game response; API paths on the game domain return 404. A normal reviewed server/helper/mobile release is still needed. Application rollout awaits the web decision; the edge fails closed until the reviewed server code is released.

Deployment source: `scripts/runnable-artifact-proxy.mjs`, launched by `node /app/game-proxy.mjs`, injected through Fly Machines `config.files.raw_value` from the exact checked-in script. Image: `docker.io/library/node@sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8`. Ports 80/443 forward to internal 8080, with TLS and HTTP handlers; HTTP redirects to HTTPS. No release pipeline changes are required.

## Proof

See [the evidence record](evidence/runnable-artifacts/README.md). This draft is not ready for merge until the web decision is resolved.
