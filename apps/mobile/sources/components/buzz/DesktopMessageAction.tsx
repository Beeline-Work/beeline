import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

type Action = 'copy' | 'reply' | 'react' | 'bookmark' | 'report' | 'forward';

/** The desktop ledger's six actions share one outline scale and named tooltip. */
export function DesktopMessageAction({
  action,
  label,
  tooltip,
  selected,
  onPress,
  onFocus,
  onBlur,
  testID,
}: {
  action: Action;
  label: string;
  tooltip: string;
  selected?: boolean;
  onPress?: () => void;
  onFocus: () => void;
  onBlur: () => void;
  testID: string;
}) {
  const [named, setNamed] = useState(false);
  const { theme } = useUnistyles();
  const ink = selected ? theme.buzz.accent : theme.buzz.ledgerQuiet;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={action === 'bookmark' ? { selected } : undefined}
      onPress={onPress}
      onFocus={() => {
        setNamed(true);
        onFocus();
      }}
      onBlur={() => {
        setNamed(false);
        onBlur();
      }}
      onHoverIn={() => setNamed(true)}
      onHoverOut={() => setNamed(false)}
      style={({ pressed }) => [styles.button, named && styles.hover, pressed && styles.pressed]}
      testID={testID}
    >
      <Svg
        width={18}
        height={18}
        viewBox="0 0 24 24"
        fill="none"
        stroke={ink}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {action === 'copy' ? (
          <>
            <Rect x={8} y={8} width={12} height={12} rx={2} />
            <Path d="M16 8V4H4v12h4" />
          </>
        ) : null}
        {action === 'reply' ? <Path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7" /> : null}
        {action === 'react' ? (
          <>
            <Circle cx={12} cy={12} r={9} />
            <Path d="M8 14q4 5 8 0M8 9h.01M16 9h.01" />
          </>
        ) : null}
        {action === 'bookmark' ? (
          <Path d="M6 3h12v18l-6-4-6 4z" fill={selected ? ink : 'none'} />
        ) : null}
        {action === 'report' ? <Path d="M5 21V3m0 0h14l-3 5 3 5H5" /> : null}
        {action === 'forward' ? <Path d="m15 5 6 6-6 6M21 11H11a7 7 0 0 0-7 7" /> : null}
      </Svg>
      {named ? (
        <View pointerEvents="none" style={styles.tip} testID={`${testID}-tooltip`}>
          <Text style={styles.tipText}>{tooltip}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.buzz.radius,
  },
  hover: { backgroundColor: theme.buzz.bgHover },
  pressed: { backgroundColor: theme.buzz.bgPressed },
  tip: {
    position: 'absolute',
    bottom: '100%',
    right: 0,
    marginBottom: theme.buzz.space.sm,
    padding: theme.buzz.space.sm,
    backgroundColor: theme.buzz.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
    zIndex: 2,
  },
  tipText: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary, whiteSpace: 'nowrap' } as any,
}));
