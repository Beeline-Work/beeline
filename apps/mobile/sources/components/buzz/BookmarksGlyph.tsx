import React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import brand from '@/buzz/brand.json';

/**
 * The Room-list bookmarks mark: the same outline bookmark the desktop
 * workspace heading already uses, sized as chrome next to MembersGlyph.
 */
export function BookmarksGlyph({
  color = brand.mark,
  size = 24,
  testID,
}: {
  color?: string;
  size?: number;
  testID?: string;
}) {
  return (
    <Ionicons
      accessibilityElementsHidden
      color={color}
      name="bookmark-outline"
      size={size}
      testID={testID}
      {...(Platform.OS === 'web' ? { 'aria-hidden': true } : {})}
    />
  );
}
