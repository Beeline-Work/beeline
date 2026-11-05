# Android Room actions

Room actions now draw in the existing Android window. The sheet owns its visibility and repository draft, so opening it avoids rendering the transcript and composer. Hidden Android dialogs also skip child reconciliation. The sheet body is unchanged; hardware Back, keyboard/autofocus, backdrop dismissal, repository cancellation/reopening and the closing fade are preserved.

Matched local release APKs used an Intel Iris Plus hardware-GPU Android 35 x86_64 emulator. OTA loading was disabled only in test APKs. Each installed APK hash and runtime marker was checked, and all native code hashes match. Temporary React profiling and timestamp hooks were removed before commit. Source and artifact hashes are in [provenance.json](provenance.json).

Five openings per case, including the first sheet after process launch; median/max milliseconds:

| Case | React render | Tap to content commit | Tap to native-frame proxy |
| --- | ---: | ---: | ---: |
| Main control |75/109|137/166|240/450|
| Native Modal without animation |63/73|104/130|250/315|
| Same-window overlay |78/103|115/161|202/263|
| Overlay with sheet-owned state, experiment |35/36|92/98|182/286|
| Final scoped overlay with dismissal preserved |32/77|53/235|171/319|

The final change improves the native-frame proxy by about 29% at both median and maximum. **The 150 ms maximum remains unmet.** Firstmate authorized shipping this improvement and measuring retained native views separately. These runs do not establish send latency, Room-load latency or production Play 144 performance. The exact five values and conservative callback-gated alternative are retained in [measurements.json](measurements.json).

Perfetto supplies app `ACTION_UP` and first-window relayout timestamps. The proxy selects the earliest complete HWUI frame whose draw starts after the sheet's layout-effect commit and, for native Modal cases, its first-window relayout. Android first-draw visibility flags are valid; skipped/incomplete frames are excluded. This is a native-frame proxy, not an optical measurement. Waiting for the JS native-layout callback can select a later frame because that callback can arrive while drawing is already underway; both metrics are reported.

[Before](sheet-before.png) and [after](sheet-after.png) match pixel-for-pixel in the body rectangle `(0,1370)-(1080,2328)`, with the same sheet/title/repository bounds. [Device checks](manual-checks.json) exercised the editors and dismissal paths without saving a Room change. Unit tests beside `HullDialog.tsx` and `RoomRepositoryChoice.tsx` cover callback freshness, Back ownership, background accessibility, repository reset and opening without a parent render.

Recompute from sanitized captures:

```sh
python3 apps/mobile/evidence/android-modal-taps/analyze.py
```

`records.json.gz` contains 25 sanitized records: five per case, with JS marks, native slice timestamps and HWUI frame data. Full Perfetto traces and the test APKs stay in private task evidence. Earlier OTA-injection runs that failed runtime provenance checks are excluded.
