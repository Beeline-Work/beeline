# Local-first cache — API 36 proof

Verified on `emulator-5554` with an isolated Personal workspace and temporary Rooms, which were archived after the run.

- [Warm navigation](warm-navigation.png): returning from the Room list renders the cached Room name, roster count, and message without a blank state or loader.
- [Warm app restart](warm-app-restart-offline.png): after force-stopping the app, disabling network access, and relaunching, the same Room name, roster count, and message render from MMKV before relay access is available.

The relay was then restored and the Room list reconciled the live message summary. The temporary Rooms and messages were removed from the active workspace at the end of the test.
