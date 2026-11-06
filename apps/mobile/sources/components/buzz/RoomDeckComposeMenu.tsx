import React, { useEffect, useState } from 'react';
import { TouchableOpacity, View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import Svg, { Circle, Path, Polygon, Rect } from 'react-native-svg';
import brand from '@/buzz/brand.json';
import {
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from '@/components/buzz/HullActionSheet';
import { RoomGlyph } from '@/components/buzz/RoomGlyph';
import { ContentTarget } from '@/components/buzz/IndexRow';
import { Typography } from '@/constants/Typography';

export type RoomDeckComposeAction = 'message' | 'room' | 'invite' | 'agent' | 'join';
const FAB_GLYPH_SIZE = 22;
/** Speakeasy: a sharp 44pt brass square. Contrast with the slab is the only
 * affordance — no drop shadow, no rounding. */
const FAB_SIZE = 44;

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    header: { backgroundColor: 'transparent' },
    headerGlyph: { color: groknight.accent },
    optionList: {},
    glyphColumn: {
      width: 30,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fab: {
      width: FAB_SIZE,
      height: FAB_SIZE,
      flexShrink: 0,
      borderRadius: groknight.radius,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: groknight.buttonPrimaryFill,
    },
    // The press feedback the FAB had as a touchable.
    fabPressed: { opacity: 0.2 },
    fabGlyph: {
      color: groknight.buttonPrimaryText,
      width: FAB_GLYPH_SIZE,
      height: FAB_GLYPH_SIZE,
      alignItems: 'center',
      justifyContent: 'center',
    },
  };
});
