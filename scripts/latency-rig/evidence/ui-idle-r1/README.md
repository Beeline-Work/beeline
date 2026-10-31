# R1: nightly reaction setup accessibility idle

## Reproduced

Built the local release fixture APK from main `4c33daff8` with
`local-attempt.sh`, using the corner's leased `se_api35` emulator
(`emulator-5554`, x86_64, 2560 MiB, four cores). The disposable server/proxy
used loopback ports 23880/23881 and the standard 100 ms RTT network profile.
Paused that script's capture before it ran, retaining its fixture backend,
then ran the capture directly with `LATENCY_RIG_SMOKE=1 LATENCY_RIG_NIGHTLY=1`.

Reproduction R1: the four arrival cases, warm open and send-text completed;
reaction setup printed `ERROR: could not get idle state.` and then
`cat: /sdcard/latency-rig.xml: No such file or directory`, aborting capture.

The screenshot showed the fixture agent's thinking line. `uiautomator events`
reported its changing content description and elapsed text every second.
The fixture send had refreshed a pending WORKING receipt. After its existing
90-second freshness deadline, a plain `uiautomator dump` succeeded with no app
change; a subsequent event capture contained only the initial window/focus
events, with no continuing content updates. This is finite active-turn UI,
not an idle animation loop. The formerly passing nightly revision predates
the new reaction scenario added after send-text by PR #3128.

The dump fix then exposed the independent composer precondition failure:
`dumpsys input_method` contained `mInputShown=false` and
`mIsInputViewShown=true`. The old OR check falsely rejected that hidden keyboard.
Brief revision 2 authorizes making the system flag authoritative.

## Demonstrated

R1 with both rig fixes, against the same built APK and local backend:

```sh
LATENCY_RIG_DEVICE=emulator-5554 \
LATENCY_RIG_DATABASE_URL="$fixture_database_url" \
LATENCY_RIG_SMOKE=1 LATENCY_RIG_NIGHTLY=1 \
node scripts/latency-rig/capture-arrivals.mjs /tmp/jellybean-r1-smoke-final

LATENCY_RIG_DEVICE=emulator-5554 \
LATENCY_RIG_DATABASE_URL="$fixture_database_url" \
LATENCY_RIG_NIGHTLY=1 \
node scripts/latency-rig/capture-arrivals.mjs /tmp/jellybean-r1-full-final
```

Both commands exited zero. Smoke measured all ten cases once. The full capture
measured all ten cases twenty times each (200 samples, zero censored timeouts),
including reaction setup recovering after two idle failures. Joins and analysis
produced the [measured report](report.md), with verified clock calibration.
The analyzer's budget/request checks still fail for corner open, reaction,
send-text and tab switch; capture completion does not claim a budget pass.
The fixture was retained across diagnostic runs; these measurements are proof
of capture completion, not a replacement nightly baseline or publication.

Regression checks: `node --test scripts/latency-rig/dump-ui.test.mjs
scripts/latency-rig/capture-ui.test.mjs` (six passing checks), and root
`npm run typecheck` passed. The helper tests cover the finite WORKING lifetime,
permanent busy failure, stale-file avoidance, malformed XML and transport
errors. The keyboard test covers contradictory flags and the older fallback.
