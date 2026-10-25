# Post-step-2 Android scenario baseline

Each row is one retained unprofiled trial, not a pooled percentile. HWUI UI p95 and JS rAF intervals measure different things. No baseline trial is dropped.

| Scenario | Trial | Worst JS gap (ms) | Missed JS opportunities | Android UI p95 (ms) | Row commits | JS interval p95 (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| history-prepend | 1 | 582.23 | 592 | 150 | 138 | 65.32 |
| history-prepend | 2 | 704.62 | 470 | 101 | 164 | 45.58 |
| history-prepend | 3 | 495.99 | 485 | 125 | 187 | 46.70 |
| optimistic-send | 1 | 159.81 | 65 | 117 | 6 | 95.46 |
| optimistic-send | 2 | 194.67 | 54 | 61 | 9 | 72.92 |
| optimistic-send | 3 | 143.17 | 31 | 150 | 5 | 41.16 |
| concurrent-streams | 1 | 406.10 | 210 | 81 | 24 | 157.22 |
| concurrent-streams | 2 | 367.90 | 218 | 73 | 19 | 99.58 |
| concurrent-streams | 3 | 321.57 | 130 | 46 | 23 | 64.71 |
| fling | 1 | 82.81 | 99 | 81 | 0 | 58.25 |
| fling | 2 | 243.51 | 107 | 48 | 31 | 48.96 |
| fling | 3 | 60.39 | 71 | 61 | 0 | 44.51 |

Fixture fingerprint: `cd7b92b10869393264cc3c20f1ff42f4c3c8a9ef77223697504231deeec64ae4`. APK SHA-256: `39821432671e797dadf9568710fe926aa573694ea4ba5f599707bc64f13ff3c1`. Embedded checkout: `314a85ea779a1af109f7352abf641e2e3bae522b`; measured-source diff is empty. Hermes/Fabric enabled; React Compiler disabled.

The release APK uses the same local build path as step 1. This full rerun includes history. The retained native emulator is Android 15 x86_64, se_api35, software GPU. It is a shared-host emulator measurement, not a physical-phone claim.

The first incomplete attempt failed before streaming timing because the second draft was below the composer. Its raw capture is retained as incomplete. Subsequent trials move to newest content outside the sample before verifying both streams; every later comparison arm must use that same precondition.
