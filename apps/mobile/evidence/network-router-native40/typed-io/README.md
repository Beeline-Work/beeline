# Bounded typed byte IO on the historical native40 cohort

2026-11-02. The candidate removes the measured multi-second JS encoding and hashing stalls on this isolated historical native40 emulator. It uses the existing Expo FileHandle byte API and Expo Crypto SHA256 ABI; the APK and native libraries are unchanged. Native writes and reads process at most64KiB per call and yield after1MiB or4ms of finite admitted work. Hiding/revoking the last consumer aborts a suspended frame and removes its owned staging file. Older binaries retain local file-format compatibility and exact incremental hashing; they never select another transport or skip integrity.

| Measurement | Previous path | Candidate, two launches |
| --- | --- | --- |
|25MiB store write wall time |2,776–3,030ms | Warm397–423ms; cold642–682ms |
|25MiB store read wall time | Not measured |411–413ms; first/last sentinel bytes correct |
| Maximum animation-frame gap during store jobs |2,959.8ms | Warm20.98–21.25ms; including cold module startup108.28–115.41ms |
|25MiB SHA256 |38,194.9ms synchronous Noble calibration |61.88–71.11ms existing native digest; independent Node digest matches |
| Canceled transfer | Not measured |9.46–13.27ms; no published URI or staging files |
| Resident file bound |131,072,576 bytes |131,072,576 bytes; below134,217,728 bytes |

The raw file format and version1 index remain compatible in either direction. The source regressions cover old local codecs, offset views, strict size/EOF checks, short/failed writes, stat-before-read, resident plus temporary byte capacity, and cancellation while a frame is suspended. Cache integrity validation now awaits the local digest with the existing flight signal and checks ownership before removal, disk write or publication. A stale hash completion cannot remove a newer same-key flight.

[Measurements](measurements.json) contain the two complete runs and the separate slow-hash calibration. [Provenance](provenance.json) identifies APK SHA256 `00eb69f56cce366a72e6b2631a473626e60050a69f12e7e2f5e2f35f927644be`, exact source hashes and final bundle SHA256 `dc84e09a6d52fbd83cb1108d591755ed5a80d96035e6ab772dffb8d4eacd41e4`. The synthetic update recorded two successful launches and zero failures; both launches reported runtime40, non-embedded source and no emergency fallback. [Completed screen](complete.png).

This is a historical-source local APK on a private API35 x86_64 emulator with candidate JS, not the exact Play binary, production OTA delivery, or a physical phone result. Store and digest timing were measured separately; no full-screen end-to-end performance pass is claimed. Cold startup still shows108–115ms gaps and the native hash call is synchronous within its short native execution. Physical phone, iOS and desktop measurements remain open. The existing authority stand-ins and main-socket limitations in the [original report](../README.md) still apply.

The private emulator, ADB server and namespace were stopped after capture. No account, shared device, owner credential state or production endpoint was used. Only portable source hashes, structured measurements and the screenshot are retained here; APKs, local databases and raw logs remain excluded. [Fixture delta](fixture-source.md).
