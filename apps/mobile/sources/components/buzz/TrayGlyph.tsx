import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from './Button';
import { compactNeedsYouCount } from '@/buzz/needs-you';
import Svg, { Path } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import brand from '@/buzz/brand.json';
import { chromeStrokeWidth } from './MembersGlyph';

/** The open box, then the tray's lip: a floor with a dip where things land. */
const BOX = 'M4.5 5.5h15v13h-15z';
const LIP = 'M4.5 14h4l2 3h3l2-3h4';
/** Measured: at the 22 px header size the box's ink ends this far inside its 44 px target. */
export const HEADER_TRAY_INK_INSET = 14.5;

/**
 * The Room-list tray mark: the one way into Needs you and Saved, sized and
 * stroked as chrome next to MembersGlyph. Selected fills the box and cuts the
 * lip out of it in `cutColor`, the surface the mark sits on.
 */
export function TrayGlyph({
  color = brand.mark,
  cutColor,
  filled = false,
  size = 24,
  testID,
  onPress,
  needsYouCount = 0,
}: {
  color?: string;
  cutColor?: string;
  filled?: boolean;
  size?: number;
  testID?: string;
  onPress?: () => void;
  needsYouCount?: number;
}) {
  const strokeWidth = chromeStrokeWidth(size);
  const glyph = (
    <Svg {...DECORATIVE_GLYPH_PROPS} height={size} testID={onPress ? undefined : testID} viewBox="0 0 24 24" width={size}>
      <Path
        d={BOX}
        fill={filled && cutColor ? color : 'none'}
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
      <Path
        d={LIP}
        fill="none"
        stroke={filled && cutColor ? cutColor : color}
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </Svg>
  );
  return onPress ? (
    <Button label="" iconOnly variant="quiet" testID={testID}
      accessibilityLabel={needsYouCount > 0 ? `Tray, ${needsYouCount} need you` : 'Tray'}
      accessibilityState={{ selected: filled }} onPress={onPress}
      icon={<View style={{ width: size, height: size }} testID="tray-icon-landmark">{glyph}{needsYouCount > 0 ? (
        <View style={styles.needsCount} testID="tray-needs-you-count">
          <Text style={styles.needsCountText}>{compactNeedsYouCount(needsYouCount)}</Text>
        </View>
      ) : null}</View>} />
  ) : glyph;
}

const NEEDS_COUNT_SIZE = 17;
const styles = StyleSheet.create((theme) => ({
  needsCount: {
    position: 'absolute',
    top: -theme.buzz.space.xs,
    right: -theme.buzz.space.sm,
    minWidth: NEEDS_COUNT_SIZE,
    height: NEEDS_COUNT_SIZE,
    paddingHorizontal: 4,
    borderRadius: NEEDS_COUNT_SIZE / 2,
    borderWidth: 1,
    borderColor: theme.buzz.bgBase,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.buzz.accent,
  },
  needsCountText: {
    ...theme.buzz.type.sectionHead,
    letterSpacing: 0,
    color: theme.buzz.textInverted,
    fontVariant: ['tabular-nums'],
  },
}));
