# Cold first-reply proof

Reproduction **cold-beebee-first-reply**: mention a never-woken Beebee in its
Workspace's #general, observe the working indicator and wait for its first reply.

## Recorded real-target baseline

Tubing Crew, 2026-10-16, Fly Machine `857614db620078`, as recorded in brief revision 3:

| UTC | Event |
| --- | --- |
| 17:52:42 | Human mention |
| 17:52:58 | Machine booted |
| 17:53:00–17:53:17 | Helper download and installation |
| 17:53:23 | Room serving; first activity |
| 17:53:27 | Model catalog posted |
| 17:54:00 | First model call |
| 17:54:09 | Reply |

The indicator took 41 seconds; the reply took 87 seconds.

## Local demonstration

`infra/free-agent/cold-start-proof.mjs` creates a disposable PostgreSQL database
and a fresh Workspace. It sends a human mention through the built server's
phone operation, checks the phone Room response and receives the working turn
over the authenticated phone live socket. The real free-agent image bootstraps
and runs the real Pi/ACP harness. Docker substitutes for Fly Machines, and a
deterministic local SSE model response substitutes for the provider.

These are **local stand-in results**, not a claim that the Fly target passed:

| Run | Indicator | First model call | Reply |
| --- | --- | --- | --- |
| Baked canonical helper, synchronous Workspace preparation | 25 ms (server Room state) | 14,249 ms | 14,273 ms |
| Baked canonical helper, background Workspace preparation | 37 ms (phone live socket) | 7,456 ms | 7,535 ms |

The generated local result and service logs retain the identifiers and
timestamps for each independent proof run.

The instrumented latter run recorded:

| UTC | Startup step | Elapsed since activation | Step duration |
| --- | --- | --- | --- |
| 18:18:36.159 | Mention | — | — |
| 18:18:39.602 | Configuration | 590 ms | 590 ms |
| 18:18:39.610 | Private home | 598 ms | 8 ms |
| 18:18:40.100 | Workspace toolchain | 1,088 ms | 490 ms |
| 18:18:41.314 | MCP bridge | 2,302 ms | 1,214 ms |
| 18:18:41.504 | ACP initialization | 2,491 ms | 190 ms |
| 18:18:43.169 | Session creation | 4,157 ms | 1,665 ms |
| 18:18:43.200 | Model selection | 4,187 ms | 31 ms |
| 18:18:43.615 | First model request | — | — |
| 18:18:43.694 | Reply observed | — | — |

Before the background change, the private-home-to-toolchain step took
**7,762 ms**: `prepareWorkspaceAdapter` reinstalled the already-installed Pi
and ACP packages through npm before starting the session. Both Room and corner
startup now use the installed harness immediately while the optional immutable
Workspace generation prepares for a later activation. No running session changes
its executable. This removes the measured registry wait from the first-turn path.
It does not establish that the original Fly gap had no other contributors.

The canonical helper archive measured 77,278,489 bytes. Baking the installed
helper adds approximately **336 MB unpacked** to the image. An incremental image
build with the base OS/Pi layers cached took **38.063 seconds**, excluding the
canonical helper build and its installer/ACP/CodeGraph verification.
The hand-build script subsequently completed the canonical build, its executable
verification and the image build in **88.473 seconds**, with existing native
Buzz tools and cached base OS/Pi layers.

## Remaining real-target proof

The Fly credential available to this session read Machine events successfully,
but the app log request returned HTTP 401. The original Machine's internal
37-second interval has not yet been attributed from its own trace. Ruby has
been asked for that trace and the fresh test Workspace/Fly timing proof required
by criterion 4. Do not treat these local measurements as satisfying that final
real-target criterion.
