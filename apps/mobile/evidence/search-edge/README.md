# Reproduction search-edge

Built the existing `scripts/room-list-proof.tsx` fixture with real RoomListToolbar,
HullDialogInput and react-native-web via:

```
node --import tsx apps/mobile/scripts/render-room-list-proof.mjs
python3 -m http.server 19351 --directory .verification/room-list
```

Open the local page, tap Search conversations, and measure the input bounding
rectangle plus computed paddingLeft against the All filter bounding rectangle.
This fixture is the stand-in for an authenticated Room list; no Android emulator
was attached (`adb devices` returned an empty list).

Before: desktop search text started at x=84 while All started at x=96
(the list began at x=76). Computed left padding was 8px.
The phone and desktop regression cases both failed: expected 20, received 8.

After: at phone width 390 and desktop width 1280, both text and All start at
x=20, with computed paddingLeft=20px. Screenshots are phone.png and desktop.png.
The underline remains full width. Right padding uses roomList.searchEnd
(computed 6.61328px), matching the toolbar's right inset around its search action.
Specific paddingLeft/paddingRight override the shared paddingHorizontal without
changing HullDialogInput or other callers. Both native-input style regression
cases pass; entering text still invokes the query callback.
