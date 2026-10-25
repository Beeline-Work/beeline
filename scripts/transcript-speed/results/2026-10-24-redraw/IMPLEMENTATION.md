# Transcript redraw boundaries

Reproduction `TRANSCRIPT-REDRAW-2` uses PR 2913's Android release fixture and control driver. The incoming-message and composer paths exposed unrelated transcript body commits.

The shared renderer captured unstable roster and channel projections, broad per-message maps, and transport-bound event callbacks. Row-specific delivery, presence, proposal and byline values now cross the memo boundary as that row's presentation. Value-stable identity projections and Room/viewer-scoped event callbacks preserve the shared renderer when visible data has not changed. Scoped callbacks retain their previous Room target after navigation.

Canonical record selection now retains unchanged window arrays. Folded cards retain equal projections, including a bounded recent cache across the live/history handoff. Live edits and reactions still change canonical row objects. Card arrival bookkeeping has its own boundary outside the memoized message body; its provider value is memoized. Descendants still receive arrival updates.

Room switches retain the existing session and list lifecycle. Stable scoped actions avoid repainting every body when the new Room's transport becomes ready. This changes neither the list engine nor durable server authority.

React Compiler remains disabled in both measured builds. Explicitly preserving these inputs removes repeated work without enabling it. A compiler could plausibly reduce other pure recomputation; additional benefit is unmeasured. It would not replace correct Room scoping or canonical window identity.

Validation includes focused session, canonical record, card context, projection, callback scope and unread-boundary tests; root typecheck; UI component policy; and the existing mobile suite. The suite's native fingerprint end-to-end case fails on the unchanged baseline as well (iOS fingerprint mismatch); local verification excluded only that case, without changing its CI gate or native pins. The separate native-import timeout passed on rerun. See the comparison report for Android visible-path proof and measurement limits.
