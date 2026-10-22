# Onboarding shared controls — R1

The original R1 inventory was posted before implementation. It is retained in `R1-before.txt`. Screenshots use main after the prerequisite policy repair landed (268b4957960146dab0061b7a1abb9eb8eaae9d50), rather than the earlier pre-repair inventory commit.

## Reproduced

R1: walk sign-in and profile selection, all welcome slides, GitHub return, repository and starter cards, agent sign-in, empty first Room, create/join Workspace, invite recovery, repository selection and New Room. The original inventory found custom controls, including grandfathered ones. Run the UI policy scanner's real consumer to see the grandfathered findings; its passing baseline did not mean those controls were shared.

## Demonstrated

The same production screens now use Button, IndexRow, InlineRow, PageHeader, RoomListSectionHeader, HullSwitch, EmptyState and ErrorBanner. `R1-after.json` records zero offences in every migrated application module. The registry removes legacy allowances (59 across 11 files); scanner rules and registered component authority are unchanged.

- Sign-in, profile, welcome progress, GitHub return and repository cards: shared errors and empty states.
- Face selection, repository modes, Workspace Back and invite alternatives: shared buttons, preserving selection, disabled state and handlers.
- Welcome illustrations, repository rows, Workspace choices, invite provenance and New Room: shared row/header compositions.
- First Room: shared empty-state anatomy and starter actions. Agent sign-in: shared step layouts and failure banner.
- Existing sheets, fields, switches, card choices and action footers remain shared.

The illustrated composer, progress dots, service marks and identity artwork are noninteractive illustration, not input or action controls. Paragraphs and status prose remain ordinary Text. These are not policy exceptions.

## Screen comparisons

`before/` and `after/` contain corresponding desktop and native Android PNGs in Obsidian and Bone. Each device folder has a results manifest. Android uses the locally built x86_64 debug APK on a leased emulator, real React Native rendering, native SVGs, real Unistyles and bundled fonts. Its small developer-tools overlay is debug instrumentation. Desktop builds the same production components with react-native-web and the bundled fonts.

Both harnesses replace account/network/device services with fixed fixtures. These are built-component demonstrations of the exact UI and callbacks, not production account creation or live OAuth/provider sign-in. Baseline and migrated runs use the same fixture inputs. The production welcome button advances every slide; native captures tap its actual accessibility target.

`preview.tsx`, `preview.mjs`, `prepare-native.cjs`, `capture.mjs` and `capture-android.py` retain the fixture and capture procedure. Run preview.mjs from the repository root; `ONBOARDING_SOURCE` selects a baseline source tree, `ONBOARDING_BUILD` selects its output directory, and `ONBOARDING_SHIMS=/tmp/onboarding-shims.json` exports fixtures for prepare-native.cjs. The native generator creates only ignored `.scratch` files and a temporary Metro config. Point Expo at that config with `EXPO_OVERRIDE_METRO_CONFIG`, temporarily set the mobile package entry to `.scratch/onboarding-native/entry.js`, then restore the entry and remove the generated config after captures. Never commit that temporary package change.

Capture scripts accept `ONBOARDING_PHASE=before|after`; native accepts `ONBOARDING_ANDROID_SERIAL`, desktop accepts `ONBOARDING_CDP_PORT`. Serve the baseline build on port 4198 and the migrated build on port 4197. Native uses the proof server on port 8197. Optional `ONBOARDING_SCREENS` limits either capture to comma-separated fixture queries.

## Validation

Results are recorded after the final source and normal package entry are restored. Interaction coverage includes face selection/save failure, invite redemption/retry, repository link/create/owner selection, agent sign-in and clipboard submission, welcome completion/recovery and starter actions. The final PR records the completed command results.
