### Pinned API contract: `onboardingFunnel`
Both PRs must state this contract verbatim. Any change needs a brief revision in both corners.

**Placement.** Additive key on each existing period entry: `periods["24h"|"7d"|"28d"|"all"].onboardingFunnel`. Same window rules as the period object (end exclusive at `measuredAt`).

**Cohort.** Eligible humans (team accounts excluded, as today) whose welcome card was first shown inside the window. Every later step counts only those people, at any time up to `measuredAt`.

**Shape.**
```json
{
  "cohort": "welcome_shown_in_window",
  "steps": [Step],
  "paths": {"task": [Step], "game": [Step], "invite": [Step]},
  "byOption": {"task": {"steps": [Step]}, "game": {...}, "invite": {...}, "special": {...}},
  "biggestDrop": "step_key" | null
}
```
`Step = {"key": string, "count": int, "eligible": int|null, "medianSecondsFromPrevious": int|null, "samples": int}`

**Step keys, in order.**
- `steps` (all users): `welcome_shown`, `option_picked`, `answered_after_pick`, `return_1d`, `return_7d`.
- `paths.task`: `task_first_answer`, `task_second_opinion`, `task_final_answer`. Previous step for the first entry is `option_picked`.
- `paths.game`: `game_posted`, `game_viewer_opened`, `game_closed`. The `game_closed` median is time in viewer.
- `paths.invite`: `invite_link_created`, `invite_shared`, `invite_opened`, `invite_friend_signed_up`, `invite_friend_messaged`.
- `byOption.<option>.steps`: the five `steps` keys, limited to users whose first pick was that option. Options: `task`=A, `game`=B, `invite`=C, `special`=D.

**Rules.**
- `option_picked` uses the first pick only. Its median is time to first tap.
- `return_1d`: a retained message 24h or more after `welcome_shown`. `return_7d`: 168h or more. `eligible` = cohort users whose welcome is at least 24h / 168h before `measuredAt`. `eligible` is null on all other steps.
- Medians: integer seconds, from the previous step in the same list, over users who reached both. `samples` = that user count. Fewer than 5 samples gives `medianSecondsFromPrevious: null`.
- First entry of each list has `medianSecondsFromPrevious: null`.
- `biggestDrop`: over `steps` only, same rule as the people funnel.
- Empty cohort: every key present, counts 0, medians null. Failed read: the existing unavailable-section shape, never zeros.

