# Corner stall investigation

Investigated October 24, 2026, using the feedback IDs carried by the corner brief.
No production database rows or helper lifecycle were changed.

## Measured cause

The retained host journal supplies the evidence added by #2844. At 04:35:46 UTC,
three agent work loops were awaiting `room-storage`, with elapsed times of
104,812–133,415 ms. The helper then exceeded its three-minute systemd watchdog
limit and exited with result `watchdog`. Production command/turn records show
claimed executions failing with the generic stall reason at 04:38:05 UTC.
The journal is readable with `journalctl -t beeline` and the helper unit's system
journal; the sandbox's user bus and an unqualified user-unit lookup were not
usable. Fly server logs were also read through the vaulted org-deploy route,
paging from a nanosecond `next_token`; a `start_time` query did not select history.
The retained server window contained slow-query observations, not an exception
that identifies the storage syscall. The evidence establishes the storage
progress barrier/watchdog failure, not which file held a particular scan.

A separate production record has `reportedGenerationId` equal to the failed
execution's generation while the turn still ends with the generic stall reason.
The report path records delivery but the silence detector checks only a chat
message. A private done report can therefore be followed by a false failure
when the helper dies before its terminal receipt.

#2892 keeps an emulator alive across model turns and supplies lease variables.
It does not change the storage progress barrier or the missing report check.
This fix does not change emulator ownership, launch or process lifetime.

## Repair

Storage inventories acknowledge actual forward movement through the existing
reconciliation progress callback, at most once per second. Linux acknowledges
received inventory chunks; macOS acknowledges completed filesystem observations.
Process inventory and owner iteration also yield progress. Room cleanup passes
the callback through open-checkout and archived-checkout reclamation. No timer
feeds a blocked operation, and the watchdog deadline is unchanged.

A delivered done report now carries its outcome beside its existing generation
marker. A timeout settles only a matching generation with a delivered done,
under the existing silence lock; older reports and blocked reports cannot hide
a current stall. The check runs again inside inscription to cover a report
committing between detection and inscription. Existing report outcomes support
older private order markers. A PR existing in a corner is not enough to settle
an unrelated turn.

A genuine timeout states elapsed receipt silence and whether the helper's
connection is present. An unclaimed corner handoff states the pickup deadline
and leaves its command pending for later delivery. These are server-observed
causes; the server does not invent an OS crash diagnosis from missing receipts.

## Reproduction and proof

`storage-watchdog`: replaying the historical host state in production would
interrupt other work. The closest isolated stand-in streams an inventory across
multiple watchdog intervals with the real local watchdog and progress barrier.
Without inventory progress, the watchdog records a stalled loop. With progress,
the scan finishes and the watchdog continues to be fed. The existing frozen
reconciliation regression still verifies watchdog expiry when no progress occurs.

`reported-stall`: the service proof opens a disposable corner, claims its worker,
delivers done through the daemon report operation, omits the terminal receipt,
and expires its receipt freshness. ConnectionPresence's actual timer settles
it complete and the commander's inbox retains only done. Run the built-service
path with `npm run build --workspace=@beeline/server` followed by
`node scripts/prove-corner-stall.mjs`. It uses an in-memory PostgreSQL stand-in;
it does not boot a production helper or make provider requests.

`explained-stall`: service regressions exercise unclaimed, disconnected and
connected-but-silent workers through the same timer, then read the corner or
commander output. The unclaimed command remains pending. Genuine claimed stalls
still spend the existing bounded retry budget. Blocked reports remain failures
on timeout; only delivered done from the current generation suppresses one.
