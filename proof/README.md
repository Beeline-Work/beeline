# Corner lifecycle emulator proof

Captured from the branch-built Android release APK on `emulator-5554`, against
the local relay/materializer at `http://127.0.0.1:3011` and a real Codex Body
daemon. The app bundle was built from `78eb7e316775e86ec70245a36ab10f20a71f5d73`
plus this branch's working tree.

The proof Room was `29671301-79a5-454c-8503-3c77c1e99950`. The approved corner
was `21c2c6a9-fc58-488b-8bc8-45bcf7eb96ba`; the externally squash-landed corner
was `6555ba03-b24f-4eb2-a7d5-402a2b0e5072`.

## Checklist evidence

1. **Full multi-turn history:** [`09-second-turn-history-review.png`](09-second-turn-history-review.png)
   shows an earlier completed reply, the second human steering turn, its model
   reply, and the accumulated two-file review after a cold reopen.
   [`16-completed-plan-archived.png`](16-completed-plan-archived.png) is another
   cold reopen after landing and still contains the prior real replies.
2. **Completed plan and full objective:**
   [`16-completed-plan-archived.png`](16-completed-plan-archived.png) shows the
   completed `Working…` step retained and crossed out on the archived corner,
   plus the expanded, complete opening objective.
3. **Review file list/diff summary:**
   [`09-second-turn-history-review.png`](09-second-turn-history-review.png)
   shows both files and their line counts; [`17-external-squash-review.png`](17-external-squash-review.png)
   independently shows the one-file review generation.
4. **Approve Merge renders and lands:**
   [`05-review-ready.png`](05-review-ready.png) shows the button,
   [`12-approve-pressed.png`](12-approve-pressed.png) shows the single standing
   approval submitted, and [`13-landed-corner-state.png`](13-landed-corner-state.png)
   shows the corner archived after the daemon landed it.
5. **Short target branch:** [`05-review-ready.png`](05-review-ready.png) and
   [`17-external-squash-review.png`](17-external-squash-review.png) both render
   `ready for review: main`, never `refs/heads/main`.
6. **Receipt-driven gold live bar:**
   [`10-gold-working-after-fix.png`](10-gold-working-after-fix.png) shows the
   gold `agent active` bar. At capture, the signed Room response carried
   `lifecycle=REVIEW`, `status=working`, and receipt `statusAt=1788146690`;
   UIAutomator exposed `resource-id="corner-status-working"`.
7. **Archived corners leave navigation:**
   [`20-all-corners-left-dropdown.png`](20-all-corners-left-dropdown.png) shows
   only the parent Room after both child corners archived; its UI tree contained
   no corner names or `corner-status` nodes.
8. **No ghost merge-approval notification:**
   [`21-no-ghost-notifications.png`](21-no-ghost-notifications.png) shows the
   notification shade after approval, landing, digest, and archival. Only
   Android system notifications are present; `dumpsys notification` contained
   no active `app.usebeeline.mobile` notification record.
9. **No merge-nag repetition:** [`11-before-approve.png`](11-before-approve.png)
   shows the clean multi-turn tail before the one approval, and
   [`13-landed-corner-state.png`](13-landed-corner-state.png) shows the clean
   terminal transcript. The relay held one signed merge-approval event for the
   approved corner.
10. **External squash identity:**
    [`17-external-squash-review.png`](17-external-squash-review.png) shows the
    ready review. Its feature tip was `3b3ebfabb5c85d4093b02bead5e65c38d6d45b84`.
    The change was squash-landed externally as the different target SHA
    `59c7da7dda00eb2bab0ae8c07bc79523e0306908`; both resolve to stable patch ID
    `e232f6c2bb0e9495bd227369cd89e61af6b6507f`.
    [`18-external-squash-archived.png`](18-external-squash-archived.png) shows
    the corner automatically archived without an approval press, and
    [`19-external-squash-digest.png`](19-external-squash-digest.png) shows its
    parent digest at `59c7da7dda00`.
11. **Tight activity-to-prose rhythm:** [`05-review-ready.png`](05-review-ready.png)
    and [`09-second-turn-history-review.png`](09-second-turn-history-review.png)
    show the dense transcript rhythm from the real tool-using turns; the direct
    component regression pins the draft gap to two pixels.
12. **No centered daemon garbage:** the cold-reopen transcripts in
    [`09-second-turn-history-review.png`](09-second-turn-history-review.png),
    [`13-landed-corner-state.png`](13-landed-corner-state.png), and
    [`18-external-squash-archived.png`](18-external-squash-archived.png) contain
    conversation only—no turn receipts, archive controls, or serialized activity.
13. **Parent Room digest:** [`14-parent-digest-archived.png`](14-parent-digest-archived.png)
    shows the approved landing digest; [`19-external-squash-digest.png`](19-external-squash-digest.png)
    shows the independently detected external landing digest.
14. **No session/restart preamble:** [`16-completed-plan-archived.png`](16-completed-plan-archived.png)
    shows the cold-reopened archived history ending in the real model reply,
    without a daemon/session restoration preamble.

All PNGs above were captured with `adb -s emulator-5554 exec-out screencap -p`.
