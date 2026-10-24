# Runnable HTML artifacts

The accepted web policy permits an outbound child-frame navigation request, then the trusted parent removes the frame on its next load. This is not a completely offline browser. The frame has no Beeline session or user data except what the person enters into the game.

An agent explicitly posts a single HTML file with `post_artifact({path, mime:"application/vnd.beeline.game+html"})`. Inline scripts and pointer/canvas games are supported. Ordinary `text/html` and SVG retain their existing inert validators and script-off transcript previews. Runnable cards also use the inert HTML preview; execution starts only after opening the viewer.

The current refusal is in Body's `artifact-validation.ts`: inert HTML rejects script elements and event handlers as well as external assets and submitting elements. The mobile `artifactWebViewProps` table disables scripts, web uses an empty iframe sandbox, and `wrapArtifactMarkup` adds a script-blocking CSP. These layers intentionally made self-contained visual mocks safe to preview in a conversation.

## Execution boundary

The authenticated app requests `/v1/media/<id>/play`. `ObjectService.runnableLink` checks the MIME and mints a ten-minute HMAC capability. No session token is embedded in the resulting game URL.

The dedicated `https://beeline-games.fly.dev` site serves `/play/<uuid>?expires=…&token=…`. `fly.dev` is a private public suffix; its game and server hostnames have different registrable domains, and the game also differs from `usebeeline.app`. `runnableOrigin` checks this using the public suffix list and rejects an application site or a non-HTTPS origin. `BEELINE_GAME_ORIGIN` can override the dedicated origin, provided its proxy configuration changes with it.

The credential-free game edge in `scripts/runnable-artifact-proxy.mjs` accepts GET game paths only. It forwards no caller cookies, authorization, or other headers; it fixes the backend Host to the game host and reaches `beeline-server.internal:8080`. The server branches before authentication or API routing and rejects every non-game path and WebSocket upgrade on that host. The edge refuses responses missing the sandbox policy, strips any Set-Cookie, follows no redirects, and bounds buffered bodies to the 25 MiB source limit plus base64 envelope overhead.

The server checks the capability, object MIME, and expiry before reading bytes from storage. Ordinary signed storage links serve runnable source as `text/plain`; they never provide a second, unsandboxed HTML execution path.

Each game response carries:

```
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'; sandbox allow-scripts
Permissions-Policy: camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), fullscreen=()
Referrer-Policy: no-referrer
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

The response sandbox makes the document's origin opaque even in a mobile top-level WebView. Cookie and storage access throws. The web iframe additionally grants only `allow-scripts`. Its initial response is a trusted shell containing the authored document as inert base64. After the first iframe load the parent arms its guard and sends a one-way start signal; only then does the shell parse the authored HTML and activate its scripts and handlers. No game-to-app message listener exists. This prevents an immediate authored redirect from being mistaken for the initial artifact load. The game still uses ordinary browser JavaScript, without an interpreter or worker. DOMContentLoaded and load handlers are dispatched after activation; parser-time `document.write` semantics are not supported by this embedded path. Mobile has no onMessage or injected JavaScript, file access, DOM storage, shared-cookie synchronization, geolocation, automatic popup permission, or fullscreen video. Its navigation callback allows the game origin only. `originWhitelist=['*']` is deliberate: the library otherwise sends disallowed URLs to the OS through Linking before consulting the callback. The callback itself rejects other origins and schemes.

The app keeps Close outside game content. A renderer crash/termination unmounts the WebView and shows “Game stopped. Close and reopen it to try again.” Opening a new artifact or closing the viewer ends the current game. On web, every later iframe load synchronously hides the frame and removes it through React, displaying the trusted message “This game tried to open another page and was closed” with a Reopen button. Reopen obtains a fresh capability and resets the load guard. The trusted viewer header labels the content as Game, and Close remains outside it on every platform.

## Mobile authentication

`monolith-session.ts` stores access and refresh tokens through `monolith-secure-storage.ts`: native uses Expo SecureStore; web uses the application's own origin storage. API requests carry Authorization bearer headers. Legacy native identity keys also use SecureStore in `buzz-identity-storage.ts`. Native sign-in uses Expo's external authentication browser rather than the artifact WebView. No Beeline API session cookie is installed by that flow in Android's WebView CookieManager.

The implementation does not enable Android incognito or clear its global cookie jar. The separate site, opaque response origin, denied network subresources, and absence of a native message bridge isolate the game from existing app secrets and any unrelated WebView cookies. No native runtime or config plugin changes are needed for the demonstrated Android path.

## Threat model

| Threat | Boundary and remaining limits |
| --- | --- |
| Session, cookie, or storage theft | No bearer reaches the game. Cross-site and opaque origins block app DOM, cookies, and storage. No native bridge exposes SecureStore. |
| API fetches or exfiltration through subresources | CSP blocks fetch, XHR, WebSocket, beacon, external scripts/styles/images, child frames, and workers. Data/blob images and inline canvas drawing remain available. |
| Phishing UI | Trusted viewer title and Close stay outside the content. The game cannot enter browser fullscreen, open popups, show sandboxed modal dialogs, or navigate the app. A malicious game can still draw deceptive text inside its own content; no sandbox can make authored text trustworthy. |
| Navigation | Web sandbox blocks top/parent navigation, popups, forms, and downloads. Mobile callback also rejects external self-navigation. **Web self-navigation can still make an outside request; the parent closes the resulting frame. This residual risk is accepted.** |
| Mining or infinite loops | CSP denies network pools and workers, but does not prohibit CPU work. Android renderer runs separately; the emulator proof demonstrates a trusted counter and Close remain usable during a real infinite loop. Close unmounts the WebView. This is termination by the user, not a CPU quota. |
| Camera, microphone, location | Opaque sandbox origin and response Permissions-Policy deny access. Native geolocation is disabled and iOS media-capture policy is deny. |
| Capability disclosure | Unguessable HMAC link, short expiry, no referrer, no shared cookies. Anyone given that link can read that artifact until expiry; there is no claim of protection against a recipient copying its contents. |

## Accepted web navigation policy

Ruby accepted confined child-frame self-navigation with a parent-owned load guard. `Reproduction HTML-GAME-NAV-1` originally left example.org visible; it now ends with the iframe removed, trusted Close still present, and the trusted stopped state plus Reopen. An immediate redirect is also tested: the trusted initial shell waits for the parent's first-load signal before activating authored content, so it cannot consume that first-load allowance.

The outbound request itself still leaves the frame before its subsequent load closes it. This is accepted residual risk, not a claim that CSP prevents navigation. The opaque frame has no Beeline session, cookies, storage, or user data beyond what the person types into the game. Resource/API fetches and top/parent navigation remain blocked. Mobile rejects the same example.org probe through its navigation callback before committing the outside page.

See [the closed web frame](evidence/runnable-artifacts/web-navigation-closed.png), [the immediate-redirect case](evidence/runnable-artifacts/web-immediate-navigation-closed.png), and [the Android navigation proof](evidence/runnable-artifacts/android-navigation-blocked.png).

## Hosting

A separate `beeline-games` Fly app was provisioned in the owner's existing organization. The edge is one 256 MiB shared-CPU Machine, autostart enabled and autostop to zero. Its root filesystem contains only the proxy script and the pinned Node runtime. It has no application credentials or database connection. No production server deployment, release workflow, or existing Machine was changed.

The production server must listen on `HOST = "::"` (dual-stack on Fly's Linux Machines). The edge reaches `beeline-server.internal:8080` over Fly private IPv6; an IPv4-only `0.0.0.0` listener refuses that connection and every game returns 503. The dual-stack listener also accepts IPv4 traffic for the public proxy and `/readyz` health checks, including the existing voice/LiveKit HTTP routes. Local development keeps its own HOST default. Listener changes ship through the normal owner-commanded release; after release, an unknown `/play/<id>` on the game domain must return the server's 404 with sandbox CSP, rather than the edge's 503.

Deployment source: `scripts/runnable-artifact-proxy.mjs`, launched by `node /app/game-proxy.mjs`, injected through Fly Machines `config.files.raw_value` from the exact checked-in script. Image: `docker.io/library/node@sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8`. Ports 80/443 forward to internal 8080, with TLS and HTTP handlers; HTTP redirects to HTTPS. No release pipeline changes are required.

## Proof

See [the evidence record](evidence/runnable-artifacts/README.md). The accepted residual risk and parent guard are part of the review contract. Mark the PR ready only after CI passes.
