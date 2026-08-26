import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  HullActionSheet,
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from '@/components/buzz/HullActionSheet';
import { HullModal } from '@/components/buzz/HullDialog';
import { useSessionQuickActions, type SessionActionItem } from '@/hooks/useSessionQuickActions';
import { useSession } from '@/sync/storage';
import {
  formatShortcutChord,
  getPreferredShortcutModifier,
  matchesShortcutChord,
  SESSION_ACTION_SHORTCUTS,
} from '@/keyboard/shortcuts';

export type SessionActionsAnchor =
  | { type: 'point'; x: number; y: number }
  | { type: 'rect'; x: number; y: number; width: number; height: number };

interface SessionActionsPopoverProps {
  anchor: SessionActionsAnchor | null;
  onAfterArchive?: () => void;
  onAfterDelete?: () => void;
  onClose: () => void;
  sessionId: string;
  visible: boolean;
}

const WEB_MENU_WIDTH = 288;
const WEB_MENU_ITEM_HEIGHT = 52;
const WEB_MENU_MARGIN = 12;

export function SessionActionsPopover({
  anchor,
  onAfterArchive,
  onAfterDelete,
  onClose,
  sessionId,
  visible,
}: SessionActionsPopoverProps) {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const session = useSession(sessionId);
  const { actionItems: actions } = useSessionQuickActions(session!, {
    onAfterArchive,
    onAfterDelete,
  });
  const preferredModifier = React.useMemo(
    () => getPreferredShortcutModifier(typeof navigator === 'undefined' ? undefined : navigator),
    [],
  );
  const position = React.useMemo(() => {
    if (!anchor) return null;
    const estimatedHeight = actions.length * WEB_MENU_ITEM_HEIGHT + 24;
    const leftBase = anchor.type === 'point' ? anchor.x : anchor.x + anchor.width - WEB_MENU_WIDTH;
    let topBase = anchor.type === 'point' ? anchor.y : anchor.y + anchor.height + 8;
    if (anchor.type === 'rect' && topBase + estimatedHeight > windowHeight - WEB_MENU_MARGIN) {
      topBase = anchor.y - estimatedHeight - 8;
    }
    return {
      left: Math.max(
        WEB_MENU_MARGIN,
        Math.min(windowWidth - WEB_MENU_WIDTH - WEB_MENU_MARGIN, leftBase),
      ),
      top: Math.max(
        WEB_MENU_MARGIN,
        Math.min(windowHeight - estimatedHeight - WEB_MENU_MARGIN, topBase),
      ),
    };
  }, [actions.length, anchor, windowHeight, windowWidth]);

  const handleActionPress = React.useCallback(
    (action: SessionActionItem) => {
      onClose();
      action.onPress();
    },
    [onClose],
  );

  React.useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !visible || !anchor || !session)
      return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = actions.find((candidate) =>
        matchesShortcutChord(event, preferredModifier, SESSION_ACTION_SHORTCUTS[candidate.id]),
      );
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      handleActionPress(action);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [actions, anchor, handleActionPress, preferredModifier, session, visible]);

  if (!visible || !anchor || !session) return null;

  const rows = actions.map((action) => (
    <HullActionSheetRow
      destructive={action.destructive}
      key={action.id}
      label={action.label}
      metadata={
        Platform.OS === 'web'
          ? formatShortcutChord(preferredModifier, SESSION_ACTION_SHORTCUTS[action.id])
          : undefined
      }
      onPress={() => handleActionPress(action)}
    />
  ));

  if (Platform.OS === 'web' && position) {
    return (
      <HullModal keyboardAvoiding={false} onRequestClose={onClose} placement="fill" visible>
        <HullActionSheet
          grip={false}
          style={[styles.webMenu, { left: position.left, top: position.top }]}
          testID="session-actions-popover"
          title="Session"
        >
          {rows}
        </HullActionSheet>
      </HullModal>
    );
  }

  return (
    <HullActionSheetModal onClose={onClose} testID="session-actions-sheet" title="Session" visible>
      {rows}
      <HullActionSheetCancel onPress={onClose} />
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create({
  webMenu: {
    position: 'absolute',
    width: WEB_MENU_WIDTH,
  },
});
