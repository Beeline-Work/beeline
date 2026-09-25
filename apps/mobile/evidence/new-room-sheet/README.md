# Native Room creation screenshots

These Android captures compare the Room creation flow with an existing Beeline bottom sheet:

| Capture | Source |
| --- | --- |
| [New Room](new-room-native.png) | Native debug build, Room form with fixture data |
| [Repository picker](repository-picker-native.png) | Same build and fixture data |
| [Create repository](create-repository-native.png) | Same build, name entered; keyboard visible |
| [Existing Message picker](existing-message-picker-native.png) | Installed Beeline app, existing bottom sheet |

The debug preview mounted the production `NewRoomDialog` component with local fixture repositories; it did not call GitHub or create a live Room. It used the existing Bone theme and native Android controls. The temporary preview entry point was removed after capture.
