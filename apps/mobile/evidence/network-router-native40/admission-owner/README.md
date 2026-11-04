# Admission owner on historical-source Android runtime 40

The production `readArtifactObject` admission owner passed on the same historical-source locally built APK documented in [the previous native proof](../current-candidate/README.md). This is not the exact Play-distributed binary. The [provenance](provenance.json) records the APK, candidate bundle and source hashes, source-map inclusion of the actual owner/connection/store/cache/digest/reset modules, and one successful native launch with zero failures or fallback.

[Measurements](measurements.json) and the [completed native screen](complete.png) show:

- Preview/Open/Save-shaped consumers shared one byte read and one metadata read. The preview admitted a16KiB bound; native storage returned a file URI.
- Capable disconnect rejected new demand without another byte call.
- Large or unavailable legacy previews were rejected before byte admission. Two later explicit legacy reads each fetched independently.
- Authoritative metadata size overrode the smaller attachment hint for preview admission.
- Cancellation while metadata was pending started no byte transfer.
- Committed authority removal synchronously notified the display, invalidated the existing result, and rejected subsequent demand without another read.

The [fixture](fixture-source.md) supplies synthetic identity, runtime origin, metadata and byte-leaf results. The actual metadata validator, admission owner, cache and native store execute unchanged. This proves neither authenticated socket negotiation nor a real network leaf, UI integration, physical-phone latency, OTA delivery or the full cohort/family matrix. No whole audit finding closes.

Reproduction uses the parent's isolated emulator/local-update delivery instructions, the archived entry/adapters, and the Metro resolver snippet. Export with two workers and a4096MiB Node heap cap. After `RUNNING_UNLOCKED`, install the locally generated update database and Hermes bundle, launch the fixture and capture `NATIVE40_OWNER` logcat records. All eight expected events and the native launch receipt were asserted before archiving. An initial copy attempted before user-data unlock failed; it installed no candidate. No application retry was introduced. Temporary fixture files and Metro changes were removed, and the private emulator/ADB namespace was stopped.
