# False corner beginning, 2026-09-27

`before.jpg` is the captain's Android screenshot of `#beeline/Passive agents`
(`Niglet · review`, GitHub change 1809, source branch
`feature/corner-0bf7d2094fef`). It shows **Beginning of corner** directly
above the 13:28 lunchboxfortwo message, although the report says earlier corner
messages exist. The screenshot is evidence of the visible symptom, not proof of
the exact server history at capture time.

Live acceptance remains pending the merge, server release, and a fresh phone
read. Verify the earlier messages render in this corner, or establish from the
production history endpoint that the displayed row is truly first. The local
regression tests cover the empty cached tail, partial tail, short first page,
reconnect, and successive pages without polling.
