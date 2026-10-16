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

## First isolated real-Fly proof (failing)

Ruby ran head `785cadd6` with an isolated server and database, fresh Fly app and
Workspace, and real DeepSeek V4.1 Flash. Mention at 18:34:10.511Z: live activity
and authenticated phone read at +83 ms (passes), first model request at +39.9 s,
reply at +44.2 s (fails the 30 s target). No helper download occurred.

Machine creation/start took 16.787 s, including a 14.8 s uncached image pull.
Agent staging finished at +20.5 s; Room serving at +24.5 s. Startup durations:
configuration 335 ms, home 25 ms, toolchain 6,344 ms, MCP bridge 1,373 ms,
ACP initialize 648 ms, session-new 5,023 ms, model selection 53 ms.

Production and Tubing Crew were untouched. Ruby destroyed the disposable app,
revoked the temporary model grant, stopped the tunnel and removed the database.
The PR remains draft until the repeated real-Fly reproduction passes.

The image now prepares a version-keyed view of its installed Pi/ACP packages
and the normal 128 MiB recovery reserve during construction. Runtime toolchain
selection reuses a complete matching generation and falls back to ordinary
Workspace preparation for another package version. MCP discovery reports each
server's elapsed time and runs independent servers concurrently. Separate
asset-layout and session-prompt timestamps distinguish filesystem and prompt
work from actual adapter/session creation on the next run.
