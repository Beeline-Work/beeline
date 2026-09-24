import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatListItem } from '@beeline/buzz-client';
import {
  loadDesktopRoomCornersExpanded,
  saveDesktopRoomCornersExpanded,
} from '@/buzz/desktop-workbench-state';
import { displayGroupedCornerTitle } from '@/buzz/room-list-row';
import { CornerGlyph, CORNER_META_SIZE } from './CornerGlyph';
import { RoomCornerSummary } from './RoomCornerSummary';
import { MineCornersToggle } from './MineCornersToggle';
import { useMineCorners } from '@/buzz/mine-corners';

export function DesktopRoomCorners({
  item,
  onOpen,
  renderDrag,
  active = false,
}: {
  item: ChatListItem;
  active?: boolean;
  onOpen: (cornerId: string) => void;
  renderDrag: (cornerId: string, children: React.ReactNode) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const touched = React.useRef(false);
  const [mine, setMine] = useMineCorners();
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
  // The chat list carries each Room's open corners; no per-Room corners read.
  const corners = [...(item.openCorners ?? [])].sort(
    (a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting'),
  );
  // With Mine on, the summary counts the rows Mine shows, not the whole Room.
  const filtered = mine && item.openCorners !== undefined;
  const visible = mine ? corners.filter((corner) => corner.mine) : corners;
  return (
    <View>
      <View style={styles.summary}>
        <View style={styles.summaryToggle}>
          <RoomCornerSummary
            count={filtered ? visible.length : (item.cornerCount ?? corners.length)}
            waiting={
              filtered
                ? visible.filter((corner) => corner.state === 'waiting').length
                : (item.waitingCornerCount ??
                  corners.filter((corner) => corner.state === 'waiting').length)
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
          {visible.length === 0 ? (
            <Text style={styles.notice}>
              {corners.length ? 'No open corners of yours.' : 'No open corners.'}
            </Text>
          ) : (
            visible.map((corner) => {
              const ready = corner.state === 'waiting';
              return (
                <React.Fragment key={corner.id}>
                  {renderDrag(
                    corner.id,
                    <Pressable
                      onPress={() => onOpen(corner.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open corner ${corner.name}, ${corner.state}`}
                      style={styles.corner}
                      testID={`desktop-corner-${corner.id}`}
                    >
                      <CornerGlyph
                        size={CORNER_META_SIZE}
                        testID={`desktop-corner-glyph-${corner.id}`}
                      />
                      <Text numberOfLines={2} style={styles.name}>
                        {displayGroupedCornerTitle(item.room.name, corner.name, corner.id)}
                      </Text>
                      <Text style={[styles.state, ready && styles.waiting]}>{corner.state}</Text>
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
