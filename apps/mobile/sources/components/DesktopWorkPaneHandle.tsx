import * as React from 'react';
import { Platform, Pressable, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { readDesktopCornerDrag } from '@/buzz/desktop-work-pane';

type Props = {
  roomId: string;
  onOpen(): void;
  onDropCorner(cornerId: string): void;
};

export const DesktopWorkPaneHandle = React.forwardRef<React.ElementRef<typeof Pressable>, Props>(
  function DesktopWorkPaneHandle({ roomId, onOpen, onDropCorner }, ref) {
    const [dropActive, setDropActive] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const [hovered, setHovered] = React.useState(false);
    const highlighted = focused || hovered;
    const webDropProps = {
      onDragEnter: (event: React.DragEvent<HTMLElement>) => {
        if (readDesktopCornerDrag(event.dataTransfer)?.roomId !== roomId) return;
        event.preventDefault();
        setDropActive(true);
      },
      onDragOver: (event: React.DragEvent<HTMLElement>) => {
        if (readDesktopCornerDrag(event.dataTransfer)?.roomId !== roomId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropActive(true);
      },
      onDragLeave: () => setDropActive(false),
      onDrop: (event: React.DragEvent<HTMLElement>) => {
        event.preventDefault();
        const selection = readDesktopCornerDrag(event.dataTransfer);
        setDropActive(false);
        if (selection?.roomId === roomId) onDropCorner(selection.cornerId);
      },
    } as const;

    const button = (
      <Pressable
        ref={ref}
        accessibilityLabel="Open work pane"
        accessibilityRole="button"
        focusable
        onBlur={() => setFocused(false)}
        onFocus={() => setFocused(true)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={onOpen}
        style={[styles.handle, highlighted && styles.handleActive, dropActive && styles.dropTarget]}
        testID="desktop-work-pane-handle"
      >
        {Platform.OS === 'web' && hovered && !dropActive ? (
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.tooltip}
            testID="desktop-work-pane-tooltip"
          >
            Open work pane
          </Text>
        ) : null}
        <Text style={[styles.glyph, dropActive && styles.dropCopy]}>
          {dropActive ? 'DROP TO OPEN IN WORK PANE' : '‹'}
        </Text>
      </Pressable>
    );
    return Platform.OS === 'web'
      ? React.createElement(
          'div',
          {
            ...webDropProps,
            'data-testid': 'desktop-work-pane-drop-target',
            style: {
              alignItems: 'flex-end',
              alignSelf: 'stretch',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              overflow: 'visible',
              position: 'relative',
              width: 0,
              zIndex: 1,
            },
          },
          button,
        )
      : button;
  },
);

const styles = StyleSheet.create((theme) => ({
  handle: {
    width: 14,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.buzz.bgRaised,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.buzz.border,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.buzz.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
    borderTopLeftRadius: theme.buzz.radius,
    borderBottomLeftRadius: theme.buzz.radius,
  },
  handleActive: {
    backgroundColor: theme.buzz.bgHighlight,
    borderTopColor: theme.buzz.accent,
    borderLeftColor: theme.buzz.accent,
    borderBottomColor: theme.buzz.accent,
  },
  dropTarget: {
    width: 150,
    paddingHorizontal: theme.buzz.space.sm,
    backgroundColor: theme.buzz.bgRaised,
    borderTopColor: theme.buzz.accent,
    borderLeftColor: theme.buzz.accent,
    borderBottomColor: theme.buzz.accent,
  },
  glyph: {
    ...theme.buzz.type.machine,
    color: theme.buzz.accent,
  },
  dropCopy: {
    color: theme.buzz.accent,
    fontSize: theme.buzz.type.sectionHead.fontSize,
    lineHeight: theme.buzz.type.sectionHead.lineHeight,
    textAlign: 'center',
  },
  tooltip: {
    ...theme.buzz.type.machine,
    position: 'absolute',
    right: 20,
    width: 128,
    bottom: 46,
    paddingHorizontal: theme.buzz.space.sm,
    paddingVertical: theme.buzz.space.xs,
    fontSize: theme.buzz.type.sectionHead.fontSize,
    lineHeight: theme.buzz.type.sectionHead.lineHeight,
    color: theme.buzz.textPrimary,
    textAlign: 'center',
    backgroundColor: theme.buzz.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.radius,
  },
}));
