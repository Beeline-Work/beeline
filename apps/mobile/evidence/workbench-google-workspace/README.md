# Workbench Google Workspace visual evidence

- `before-existing-phone.png`: existing native Android Workbench frame from `../workbench-title-hierarchy/before-workbench.png`, captured before this change. It shows the prior Google heading without a usable Connect action.
- `before-phone.png`: native Android release build in this task's emulator, before the change. The release build could not read the local verification fixture and showed its network state.
- `after-web-connect.png`: updated Expo app at a 390 × 844 phone viewport against the local Workbench fixture. The Google row uses one Connect action, official Google mark, and the four-tool explanation.
- `after-web-cancelled.png`: the same updated app after an incomplete authorization return, showing a quiet line and Connect.
- `after-web-squire-no-helper.png`: the updated single Trusty Squire page with no eligible online helper.

The web frames are app renders, not the approved mock. Expo's development-only accessibility toast is visible at the bottom. The Android debug build launched, but its stored identity could not load Workbench data from a fresh local fixture, so a post-change native Workbench frame and a live Google consent round remain phone acceptance work. The OAuth client in the fixture is synthetic; automated server tests verify that the one authorization request includes all four tool scopes and that cancellation, denial, and expiry return to a retryable Connect state.
