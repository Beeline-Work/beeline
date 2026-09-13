# Desktop Workspace navigation evidence

Captured in Chrome at 1440×900 against an isolated local `@beeline/server` database. The identity owned `Burd Nest` (one Room) and `Empty Flight` (no Rooms), and was also a member of `Beeline Welcome`.

## Reproduced

1. Open `Burd Nest` → `#General`.
2. Open the Workspace switcher.
3. Select `Empty Flight`.

Before the fix, the switcher closed and the sidebar header briefly changed to `Empty Flight`, but the URL remained on Burd Nest's Room and the transcript continued to show `#General`. The stale Room then persisted Burd Nest as active and reverted the sidebar. The console contained no navigation exception; the only error was the pre-existing React Native Web `accessibilityElementsHidden` DOM-prop warning.

- [Switcher before the failing click](reproduced-empty-before-click.png)
- [Stale URL/transcript after the click](reproduced-empty-after-click.png)

## Demonstrated

After the fix, switching to `Empty Flight` navigates to `/beeline/channels?communityId=22222222-2222-4222-8222-222222222222`, closes the switcher, updates the sidebar, and paints the empty Workspace state. Switching back to `Burd Nest` opens its last Room with the Workspace in the URL. Browser Back restores the empty Workspace in both panes, and reload preserves the same URL and state.

- [Empty Workspace after switching](demonstrated-empty-after.png)
- [Populated Workspace after switching](demonstrated-populated-after.png)
- [Empty Workspace restored with Browser Back](demonstrated-back-to-empty.png)

Escape and click-outside both closed the switcher. Direct links to both the empty Workspace URL and populated Room URL reconciled the persistent sidebar; reload preserved each. Tauri has no separate navigation implementation: its desktop shell mounts the same Expo Router bundle, `SidebarNavigator`, and `SidebarView` path tested here.
