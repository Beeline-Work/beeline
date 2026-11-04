# Plain socket read proof

The phone reads through `live-connection.ts`: three attempts total, reconnecting after failure, then the shared error row. Retry and committed pushes call the same read directly. The transport has no separate recovery allowance, read scheduler, resume cursor, network-change trigger or timed draft cache.

This proof used a task-owned Android API 35 x86_64 emulator and the local Beeline Review identity, with two 100-message Rooms and an empty Room. The server used the real migrated test database, authentication, PhoneService and WebSocket dispatcher. No personal or production workspace was used.

The candidate APK retains the historical runtime-40 native libraries, embeds the candidate JavaScript, points at the isolated local server, and is signed with a disposable proof key. OTA loading was disabled only in this proof APK so it could not replace the candidate bundle. This is an installed emulator proof, not a Play release or physical-device claim.

The installed Hermes bundle SHA-256 is `57a07e694a867203b4f9618645fcd1d64d78218675feb7be4203e79f1e066f36`. The current-source export was byte-identical to its JavaScript input (`59705c824237905824bd6958b45c31135a043aa5e771e9d5c7536c774190462f`). Original and candidate APK hashes and timestamped observations are in [observations.json](observations.json).

| Case | Observed result |
| --- | --- |
| List and busy Room | Three proof Rooms loaded; busy history and the sent probe remained visible. |
| Server read failure | Read counter 18 → 21: exactly three failures, then only the shared error row. Restoring the server and Retry loaded the empty Room; the busy Room also loaded. |
| HOME for 10 seconds | Returned after 13.6 seconds, with history and the sent probe visible. |
| Airplane mode | Disabled Wi-Fi and the guest Ethernet link as well as airplane mode. Cached history remained visible; exhausted reads showed Retry. After restoring the links, Retry refreshed authorization and loaded history in one successful server read (24 → 25). |
| Ten rapid Room switches | Alternated between the two busy Rooms about every 1.5 seconds. Ten switches produced ten reads (25 → 35), ending with the sent probe visible. |
| Five-minute idle | Idle for 488.9 seconds. History and the sent probe remained visible; the Room-read counter stayed at 35. |

No `Unable to find viewState for tag`, fatal JVM exception or native signal crash was observed during the final run. Native mounting code was not changed.

Screenshots: [Room list](room-list.png), [exhausted read error](error-row.png), [radio recovery](radio-recovered.png), [after idle](after-idle.png).

The 1,900-active-Room dataset is covered separately by `router-large-workspace.integration.test.ts`, which runs the real phone socket client and server. It loads the existing 200-row first page (`truncated: true`) and a busy Room; the service's ordinary pagination contract is preserved. The same suite kills a socket mid-read and verifies exhausted failures followed by successful Retry.

[Socket section inventory](../../../../data/plain-read-reconnect-core-inventory.md) records the final line counts, section jobs, removed mechanisms and retained write/MCP boundaries.
