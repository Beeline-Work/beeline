# Android byline font measurements

Reproduction **BYLINE-ANDROID-001**: system font scale 1.1, density 420,
1080×2340, force-stop Beeline, then reopen the cached Transcript A Room.
The local transcript fixture contains an agent named Ruby with model Opus 5.5
and a human named lunchboxfortwo. No artificial font delay is used in the
natural before/after runs.

## Reproduced

The first bad adjacent shipped release is v0.0.132
(`153452ab6edeaa0ce6693250e0e57ad31939fae6`): both names clip in two of
three cold reopens. Its predecessor v0.0.131
(`4edb2287e77f2a90c139195dc49ca954bdfe4ad2`) keeps them whole in five of
five reopens. See `release-131.png` and `release-132.png`.

The only root-layout change between those releases is
`0b236af1963db7e9e89cb52aea738666cba71585` (#1810). It removed the render
gate waiting for `loadFonts()`. Ledger did not change in that interval.
Android can measure a requested but unloaded Space Grotesk face using its
narrower fallback, then retain that measurement when the real face arrives.
Clipped boxes measure about 38.48 / 121.90 dp (agent / human), versus
43.43 / 135.62 dp when measured with the actual fonts.

Shipped Expo bundles were downloaded with their manifest SHA-256 verified:

| Release | Expo Android update | Original bundle SHA-256 |
| --- | --- | --- |
| v0.0.131 | 01a0e46d-58a1-7969-8d27-34f0de83713d | 6f4d69eed8ee7c5380bd715b5dcf379654f492834fcaca3ae7960a4ef42f35c2 |
| v0.0.132 | 01a0e5e0-d5de-7324-a785-e6d8db5e7261 | d492c840f2a67a0059575ba4f4a61c6b23125eabacdc85ba4441eb5cd8ceefcb |

These are **fixture stand-ins**, not untouched store APKs: the shipped
JavaScript runs inside the same historical native release shell, with its
historical font assets. The only JavaScript substitution is an equal-length
backend URL pointing to the isolated local monolith; the Hermes checksum is
recalculated. The shell is signed with the fixture key. No font or timing
fault is injected. Initial runs with missing historical assets are excluded.

Separately, release builds of #1810 and its parent 29d4a9db9, each with an
identical injected font delay, confirm the same mechanism: the parent renders
whole names, while #1810 retains the fallback widths. This is supporting
controlled evidence, distinct from the natural runs above.

The unchanged f25b955b6 local release also reproduces naturally
(`before-owner-settings.png`). The race's recent onset on the owner's phone
is **unconfirmed**. A font-size or display-size change is a possible trigger,
not an established fact.

## Demonstrated

The fix requests explicit fallback faces while the byline fonts load, then
changes the font-family props once they are ready. This forces Android to
measure the actual faces. Text stays readable and the navigator still mounts
on its first render; the root layout and splash behavior are unchanged.
The shared byline also protects ActivityTimeline's streaming handle and role.

Names retain their intrinsic width until they exhaust the words row. Role,
status and time shrink first; exceptionally long names remain bounded and
truncate on one line. Model wording is unchanged.

| Natural check | Before | After |
| --- | --- | --- |
| Exact owner settings | visible clipping captured | five of five cold reopens show full names |
| 360 dp, Bone / Obsidian | three runs per theme; clipping captured in Obsidian | five of five per theme show full names |
| 412 dp, Bone / Obsidian | three runs per theme; no clipping observed in this finite sample | five of five per theme show full names |

Both matrix sizes retain font scale 1.1 and density 420; physical widths are
945 and 1082 pixels. The exact owner check separately uses 1080×2340.
`before-runs.json`, `after-runs.json` and `after-owner-runs.json` retain the
individual results and measured name boxes. Matrix screenshots pair
`before-<width>-<theme>.png` with `after-<width>-<theme>.png`, each containing
agent and human rows. A clean before image does not clear an intermittent bug.

At 360 dp, `after-name-fits-360.png` shows a long but fitting author name in
full while role/time ellipsize. `after-very-long-name-360.png` shows a name
that exhausts the row: metadata has disappeared before the name truncates.

Validation: Android release build passed; root `npm run typecheck` passed;
Ledger, ActivityTimeline, font-startup and unread-dot browser suites passed
(98 tests). The added pending-font regression fails on the old Ledger, which
requests SpaceGrotesk-Medium before readiness; see `regression-before.txt`.
The layout assertion also fails on the old source. Existing browser proof
executes the real message row with the updated fonts mock.

`after-streaming-360.png` captures the real streaming corner's draft and full
Ruby footer. The ActivityTimeline test separately exercises its shared author
and model byline with fonts pending.

Production reviewer web verification is pending a human sign-in handback.
The existing browser session is lunchboxfortwo, so it is not counted
as reviewer proof. Sealed loading of the value-only reviewer bypass link was
refused with `unsupported_credential_type`; a browser share and a fresh vault
approval were posted in the corner. That approval expired; resuming returned
`credential_fetch_refused / credential_fetch_approval_expired`. This branch is not deployed, and no
production fixed-result claim is made.
