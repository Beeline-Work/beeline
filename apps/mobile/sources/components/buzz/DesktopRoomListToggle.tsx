import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useDesktopLayout, toggleDesktopRoomList } from '@/buzz/desktop-layout-state';
import { Button } from './Button';

export function DesktopRoomListToggle() {
  const { showRoomList } = useDesktopLayout();
  const { theme } = useUnistyles();
  return (
    <Button
      label=""
      iconOnly
      variant="quiet"
      testID="desktop-toggle-room-list"
      accessibilityLabel={showRoomList ? 'Hide room list' : 'Show room list'}
      onPress={toggleDesktopRoomList}
      icon={<Ionicons name="menu-outline" size={20} color={theme.buzz.ledgerQuiet} />}
    />
  );
}
