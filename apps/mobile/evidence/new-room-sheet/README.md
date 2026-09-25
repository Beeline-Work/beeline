# Native Room creation screenshots

These 390 × 844 captures compare Room creation with an existing Beeline bottom sheet. The repository picker groups by the owner in each `owner/repo` name, not by GitHub App installation — the same installation can grant repos from several owners.

| Capture                                                       | Source                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| [New Room](new-room-native.png)                               | Production `NewRoomDialog` with fixture data                        |
| [Repository picker](repository-picker-native.png)             | Same build; Beeline-Work and Trusty-Squire under their own headings |
| [Create repository](create-repository-native.png)             | Same build, name entered                                            |
| [Existing Message picker](existing-message-picker-native.png) | Installed Beeline app, existing bottom sheet                        |

The preview mounts the production `NewRoomDialog` with local fixture repositories; it does not call GitHub or create a live Room. It uses the existing Bone theme. The fixture puts Beeline-Work/beeline plus two Trusty-Squire repos on one Beeline-Work installation — the case that used to render as `Beeline-Work · 3 REPOS`.

```sh
node apps/mobile/evidence/new-room-sheet/preview.mjs
# then chrome-devtools-axi open http://127.0.0.1:4188/?step=form|picker
# chrome-devtools-axi resize 390 844
# chrome-devtools-axi screenshot <path>
```
