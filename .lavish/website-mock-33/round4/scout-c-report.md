# Round 4 — In good company / independent Astra direction 1

Delivered one self-contained, offline editorial direction for firstmate to collect into the main comparison. It contains five full-screen sections, click-to-advance stories, real Beeline message components and 32 PNG frames covering every story beat at desktop and phone sizes. No live service, agent lifecycle, publication, tunnel or review board was used.

## Three-sentence rationale

Oversized editorial typography makes each section’s promise readable before the product demonstration begins. A single active speaker, message or connection holds attention while the rest of the cast recedes, preserving the Room’s value without making visitors read an accumulating transcript. The real animal identities give the page a warm, recognizable cast, while the golden invitation scene makes bringing an existing agent—with its tools, skills and control panel—the central graphical event.

## Collect these artifacts

- Offline entry point: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/index.html`
- Entire self-contained folder: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/`
- Portable collection archive: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/handoff.zip`
- Implementation: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/RoomPreview.tsx`
- Styling: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/style.css`
- Bundled runtime: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/room.bundle.js`
- Local assets: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/assets/` and `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/fonts.css`
- Frame directory: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/`
- Usage/rebuild notes: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/README.md`
- Component source hashes: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/component-sources.json`
- Per-frame validation: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/validation.json`
- Interaction evidence: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/interaction-checks.json`
- Browser evidence: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/console.txt` and `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/network.txt`

Collect the folder or archive before this disposable worktree is removed; the report alone does not contain the binary artifacts.

## What the direction does

1. Hero: Beeline and its existing mark, “Team chat for humans and agents,” all five requested download platforms, one focused grok bot message, and enlarged real animal identities.
2. Shared context: Alan asks, grok bot answers, then Jimmy sees the same Room and contributes from his phone; one message appears at a time, with the active speaker clear and everyone else dimmed.
3. Existing agent: the exact requested prompt appears in an existing Codex session; the next beat dims the terminal and reveals that same agent in the Room with tools, skills and project visibly retained. The supported harness list is below the story.
4. Agents work together: nine click-controlled beats cover Alan, Jimmy, grok bot, Codex, Claude Code and Hermes, with exactly one active node and edge. Trusty Squire → YouTube gets its own large connection scene, followed by an illustrative posted video and the actual TranscriptCard component.
5. Features: four short statements about shared Rooms, existing setup, visible work and phone/desktop access, followed by the same platform controls.

The page uses natural scrolling between sections and explicit Next/Previous/Replay controls inside stories. There is no timer or wheel interception. Stable deep links are supported, for example `index.html?section=3&beat=1` and `index.html?section=4&beat=7` (beats are zero-based).

## Source and fidelity evidence

- Real production UI imports and adapters: `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/RoomPreview.tsx:3` (LedgerEntry), `:4` (IdentityMark), `:5` (ChannelHeaderTitle), `:6` (TranscriptCard), with their use at `:9`, `:10`, `:11`, and `:36`.
- The actual source components are unmodified; SHA-256 provenance is in `component-sources.json`. Device services are isolated with the existing `apps/mobile/sources/test/browserProof.ts` shims.
- The surrounding Room window, terminal, network, connection art and subdued decorative composer are fixture shells, not a running signed-in application.
- The harness list is verified against `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/apps/body/src/session-join/agents.ts:8` and its LABELS at `:11`: Claude Code, Codex, OpenCode, Pi, Antigravity, Gemini CLI, Hermes, ZCode.
- The first three dialogue beats preserve the supplied Option 2 script. Alan’s implementation instruction removes the prohibited website terminology; individual Codex/Claude acknowledgments and the Hermes connection/result beats are explanatory mock additions.
- The earlier round-3 source and screenshots in slot 24 were read only. This direction uses a new five-chapter composition instead of the previous full transcript surrounded by all participants.

## Validation

Commands run from `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy`:

```sh
node --import tsx .lavish/website-r4-astra-1/build-room.mjs
python3 .lavish/website-r4-astra-1/capture.py
python3 .lavish/website-r4-astra-1/check-interactions.py
```

All browser operations use `chrome-devtools-axi` with the isolated session `beeline-r4-astra-1`. The page was opened directly with a `file:///` URL. The 32-frame validation confirms 1440×900 and 390×844 output, no horizontal overflow, no section overflow, one lit network node/edge, and no overlap between the final report and its controls. Visual inspection caught and fixed the initial phone context overflow and arrival/report overlaps before the final capture pass.

Keyboard Enter advances and replays all three interactive stories; the local download notification is verified. The page contains no prohibited website terminology. Browser resource evidence contains only local file/data resources, and the captured console is empty. Reduced-motion styling is present; a full assistive-technology or reduced-motion emulation audit was not performed. An initial evidence check tried reading CSS rules through file-origin CSSOM, which Chrome disallowed; the verification script now checks the local stylesheet directly.

Only `.lavish/website-r4-astra-1/` is added to the worktree. No production source was modified, so repository-wide application tests were not run for this mock.

## Unverified / intentionally illustrative

- The exact one-prompt `join my Beeline workspace at usebeeline.app/mcp` endpoint is requested future-facing copy; it was not exercised and the page explicitly marks the flow unverified.
- Harness support was verified in source, not by starting any installed harness.
- Download controls are local mock notifications, not real platform downloads.
- Trusty Squire account connection, video generation, YouTube publication and the final report are scripted illustrations. No account was connected and nothing was published.
- No real third-party logos are used. The knight for Trusty Squire and play tile for YouTube are placeholder marks; harness identities are the real Beeline animal components. The Beeline mark itself is the existing project asset.
- The video poster is a graphic placeholder, not a playable generated video.

## Recommendation and decision inventory

Include this direction in firstmate’s main comparison as the warm editorial, animal-led alternative. Preserve its one-message focus, obvious context-sharing story and separate existing-agent invitation scene when iterating. This worker handoff opens no new blocking product decision; selection among the shotgun directions belongs to the main review already requested.

Completion gate passed: `FM_HOME=/home/lunchbox/firstmate2 /home/lunchbox/firstmate2/bin/fm-captain-hold.sh complete beeline-beeline-website-astra-shotgun-attempt-1-10 --none` returned `complete: beeline-beeline-website-astra-shotgun-attempt-1-10 captain-call inventory reviewed`. No unresolved captain call was opened by this worker. The portable archive is 3,876,140 bytes.

## Complete frame inventory

### 1440px

- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/01-hero-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/02-context-01-alan-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/02-context-02-grok-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/02-context-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/03-bring-02-arrival-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/03-bring-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-01-ask-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-02-research-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-03-decide-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-04-direct-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-05-build-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-06-fix-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-07-brief-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-08-connect-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-09-report-1440.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/05-features-1440.png`

### 390px

- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/01-hero-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/02-context-01-alan-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/02-context-02-grok-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/02-context-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/03-bring-02-arrival-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/03-bring-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-01-ask-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-02-research-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-03-decide-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-04-direct-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-05-build-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-06-fix-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-07-brief-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-08-connect-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/04-together-09-report-390.png`
- `/home/lunchbox/.treehouse/buzzy-655f97/20/buzzy/.lavish/website-r4-astra-1/frames/05-features-390.png`

