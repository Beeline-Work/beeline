import React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

/** The status tray's backdrop bar, light mode only. SDK 55 forces Android
 *  edge-to-edge, so app content paints under the system tray and Bone's cream
 *  canvas left the tray reading as one washed field with the surface below.
 *  This view fills exactly the tray's inset strip with bgRaised — the
 *  language's persistent raised stop — so the tray stands apart from the app
 *  surface. Dark mode keeps the tray it already has. */
export const StatusTrayBackdrop = React.memo(() => {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="none"
      testID="status-tray-backdrop"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: insets.top,
        backgroundColor: theme.dark ? 'transparent' : theme.buzz.bgRaised,
      }}
    />
  );
});
