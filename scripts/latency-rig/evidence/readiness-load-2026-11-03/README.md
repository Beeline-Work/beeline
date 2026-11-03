# Readiness and load gate proof

Reproduction rig-1: on squire, run the real `nightly-run.sh` with a private
`LATENCY_RIG_STATE` and `LATENCY_RIG_LOAD_WAIT_MS=0`. This samples actual host
load, immediately expires the gate, retries once, and journals the contended
night without starting a fixture or acquiring an emulator. See `real-run.txt`.
Zero wait bounds this manual proof; the default wait is 45 minutes, stopping
at the 04:00 Eastern replay window. No host processes were stopped to free CPU.

The gate boundary/waiting and rig-2 delayed-listener proof run in
`waits.test.mjs`. Its real TCP server starts late; the wait must complete before
the request path. Removing either wrapper wait fails the regression.

Uncontended calibration and full capture remain unproven: the host stayed well
above the existing contention limit, and this corner had no attached emulator.
The next scheduled post-merge night remains a required operational check.
Do not interpret this evidence as confirmation that load caused calibration
uncertainty. No clock or measurement rule has changed.
