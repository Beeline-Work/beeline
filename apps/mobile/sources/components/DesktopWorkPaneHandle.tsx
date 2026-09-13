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
    const [highlighted, setHighlighted] = React.useState(false);
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
        onBlur={() => setHighlighted(false)}
        onFocus={() => setHighlighted(true)}
        onHoverIn={() => setHighlighted(true)}
        onHoverOut={() => setHighlighted(false)}
        onPress={onOpen}
        style={[styles.handle, highlighted && styles.handleActive, dropActive && styles.dropTarget]}
        testID="desktop-work-pane-handle"
      >
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
            style: { display: 'flex' },
          },
          button,
        )
      : button;
  },
);

const styles = StyleSheet.create((theme) => ({
  handle: {
    alignSelf: 'stretch',
    width: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.groupped.background,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.divider,
  },
  handleActive: {
    backgroundColor: theme.buzz.accent,
  },
  dropTarget: {
    width: 112,
    paddingHorizontal: 10,
  },
  glyph: {
    ...theme.buzz.type.machine,
    color: theme.colors.textSecondary,
  },
  dropCopy: {
    color: theme.colors.groupped.background,
    textAlign: 'center',
  },
}));
