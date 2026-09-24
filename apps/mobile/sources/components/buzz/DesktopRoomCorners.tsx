import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatListItem, CornerListItem } from '@beeline/buzz-client';
import type { RoomViewClient } from '@/sync/transport/room-view-client';
import {
  loadDesktopRoomCornersExpanded,
  saveDesktopRoomCornersExpanded,
} from '@/buzz/desktop-workbench-state';
import { cornerDisplayItems, cornerDisplayState } from '@/buzz/corner-display-state';
import { displayGroupedCornerTitle } from '@/buzz/room-list-row';
import { mineCorners, useMineCorners } from '@/buzz/mine-corners';
import { RoomCornerSummary } from './RoomCornerSummary';
import { MineCornersToggle } from './MineCornersToggle';

export function DesktopRoomCorners({
  item,
  client,
  viewerPubkey,
  refreshKey,
  onOpen,
  renderDrag,
  active = false,
}: {
  item: ChatListItem;
  client: RoomViewClient | null;
  viewerPubkey?: string;
  refreshKey: string;
  active?: boolean;
  onOpen: (cornerId: string) => void;
  renderDrag: (cornerId: string, children: React.ReactNode) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [corners, setCorners] = useState<readonly CornerListItem[] | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const touched = React.useRef(false);
  const [mine, setMine] = useMineCorners();
  const visible = corners && mineCorners(corners, viewerPubkey, mine);
  useEffect(() => {
    let cancelled = false;
    void loadDesktopRoomCornersExpanded(item.room.id, active)
      .then((value) => {
        if (!cancelled && !touched.current) setExpanded(value);
      })
      .catch(() => {
        if (!cancelled && !touched.current) setExpanded(active);
      });
    return () => {
      cancelled = true;
    };
  }, [item.room.id, active]);
  useEffect(() => {
    if (!expanded || !client) return;
    let cancelled = false;
    setError(false);
    void client
      .corners(item.room.id)
      .then((view) => {
        if (!cancelled)
          setCorners(
            cornerDisplayItems(view.corners)
              .map(({ item }) => item)
              .filter((corner) => corner.state !== 'archived')
              .sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting')),
          );
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [
    expanded,
    client,
    item.room.id,
    item.cornerCount,
    item.waitingCornerCount,
    refreshKey,
    retry,
  ]);
  return (
    <View>
      <View style={styles.summary}>
        <View style={styles.summaryToggle}>
          <RoomCornerSummary
            count={mine && visible ? visible.length : (item.cornerCount ?? corners?.length ?? 0)}
            waiting={
              mine && visible
                ? visible.filter((corner) => corner.state === 'waiting').length
                : (item.waitingCornerCount ??
                  corners?.filter((corner) => corner.state === 'waiting').length)
            }
            expanded={expanded}
            onPress={() => {
              touched.current = true;
              setExpanded(!expanded);
              void saveDesktopRoomCornersExpanded(item.room.id, !expanded).catch(() => undefined);
            }}
            testID={`desktop-room-corners-toggle-${item.room.id}`}
          />
        </View>
        {expanded && (
          <MineCornersToggle
            mine={mine}
            onChange={setMine}
            testID={`desktop-room-corners-mine-${item.room.id}`}
          />
        )}
      </View>
      {expanded && (
        <View style={styles.list} testID={`desktop-room-corners-${item.room.id}`}>
          {error ? (
            <Pressable
              onPress={() => setRetry((value) => value + 1)}
              accessibilityRole="button"
              style={styles.corner}
            >
              <Text style={styles.name}>Could not load corners. Retry</Text>
            </Pressable>
          ) : visible === null ? (
            <Text style={styles.notice}>Loading corners…</Text>
          ) : visible.length === 0 ? (
            <Text style={styles.notice}>
              {corners?.length ? 'No open corners of yours.' : 'No open corners.'}
            </Text>
          ) : (
            visible.map((corner) => {
              const state = cornerDisplayState(corner);
              return (
                <React.Fragment key={corner.corner.id}>
                  {renderDrag(
                    corner.corner.id,
                    <Pressable
                      onPress={() => onOpen(corner.corner.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open corner ${corner.corner.name}, ${state.word.toLowerCase()}`}
                      style={styles.corner}
                      testID={`desktop-corner-${corner.corner.id}`}
                    >
                      <Text numberOfLines={2} style={styles.name}>
                        {displayGroupedCornerTitle(
                          item.room.name,
                          corner.corner.name,
                          corner.corner.id,
                        )}
                      </Text>
                      <Text style={[styles.state, corner.state === 'waiting' && styles.waiting]}>
                        {state.word}
                      </Text>
                    </Pressable>,
                  )}
                </React.Fragment>
              );
            })
          )}
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  summary: { flexDirection: 'row', alignItems: 'center', paddingRight: theme.buzz.space.md },
  summaryToggle: { flex: 1 },
  list: {
    paddingLeft: theme.buzz.space.lg,
    paddingRight: theme.buzz.space.md,
    paddingBottom: theme.buzz.space.md,
  },
  corner: {
    minHeight: 48,
    paddingVertical: theme.buzz.space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  name: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary, flex: 1 },
  state: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  waiting: { color: theme.buzz.accent },
  notice: {
    ...theme.buzz.type.meta,
    color: theme.buzz.ledgerQuiet,
    paddingVertical: theme.buzz.space.md,
  },
}));
