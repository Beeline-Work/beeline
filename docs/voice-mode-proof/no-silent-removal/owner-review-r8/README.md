# Revision 8 owner copy correction

The Room list now reads `● Ongoing call: Sam`, as approved in brief revision 8. Only its label changed; the Room header pill retains `Call · …`. This is not a defect report.

[07-room-list.png](07-room-list.png), artifact **242fc371-c8b7-45ee-b74e-8d0ed519a48d**, replaces only capture 7 in the [accepted revised revision 7 set](../owner-review-r7-revised/README.md). The owner hold remains. The full-phone Android capture shows five seeded Rooms, with a running call and its brass 0:33 in the same time column as the other rows. [chats.json](chats.json) records the server roster.

The existing runtime-39 Android debug app loaded this checkout through Metro and the same temporary local-auth boot used for revision 7. PGlite and local LiveKit supply the seeded Room and Sam participant. No production data or release was used. The boot module and entry import were removed, and the emulator, server, Metro and owned container stopped after capture.

Verification: 10 existing Room preview tests and mobile typecheck pass; corner preparation/build passes. No lifecycle, layout, waveform or turn-path changes were made. The six accepted in-Room captures remain valid.

The first cold launch crashed natively before Android joined any call. Relaunch succeeded and produced this capture. The [trace](cold-launch-crash.txt) is retained under feedback item fb_65765cb368e116d4699703ca; its cause is not established by this copy change.
