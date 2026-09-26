import React, { useMemo, useState } from 'react';
import { MaybeTourTarget } from '@/components/buzz/tour/TourTarget';
import { FlatList, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router } from 'expo-router';
import type { CornerListItem } from '@beeline/buzz-client';
import { isMineCorner } from '@/buzz/mine-corners';
import { cornerHref } from '@/buzz/corner-navigation';
import { cornerDisplayState } from '@/buzz/corner-display-state';
import {
  archivedCornersLabel,
  cornerClosedStamp,
  type ArchivedCornersState,
} from '@/buzz/archived-corners';
import { fullCornerTitle } from '@/buzz/room-list-row';
import { CHANGES_LABEL, CORNER_LABEL } from '@/buzz/vocabulary';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { StateCircle } from '@/components/buzz/MonoHull';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { Typography } from '@/constants/Typography';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';

/**
 * The Room's dedicated corners index, in three folding sections: Mine (the
 * viewer's corners and any waiting on them) starts open and uncapped, Others
 * starts open when Mine is empty and otherwise folded, and Archived starts
 * folded and pages ten at a time from the server. Fold state lives only as
 * long as the screen does.
 * The desktop work pane's corner list keeps its own five-row window
 * (`inspectorCornerWindow`); this screen does not share that cap.
 *
 * The row reads in the index vocabulary `DESIGN.md` gives the Room list: the
 * opener's small face tile, the name at the brightest tier, one quiet line
 * under it, and a reserved trailing column. Two rules the row must keep:
 * it never leaves its state to the circle alone — a coloured dot is the one
 * encoding a colour-blind reader and a screen reader both lose, so the state
 * word travels beside it — and it never truncates the corner's name, which
 * wraps instead, uneven row heights and all.
 *
 * The archived footer stands at the bottom of every Room, including one with
 * no corners at all: closed work is not in this surface's read, so the row is
 * the only sign the Room has a past. Its list arrives on tap and lands under
 * the live rows, newest closure first, each stamped with its age.
 */
type Entry =
  | {
      readonly kind: 'fold';
      readonly key: 'mine' | 'others';
      readonly label: string;
      readonly open: boolean;
    }
  | { readonly kind: 'row'; readonly item: CornerListItem };

export function RoomCornersList({
  corners,
  parentRoomName,
  parentRoomId,
  refreshing,
  onRefresh,
  bottomInset = 0,
  archived = { status: 'idle' },
  onShowArchived,
  onMoreArchived,
  viewerPubkey,
  nowMs,
}: {
  corners: readonly CornerListItem[];
  parentRoomName: string;
  parentRoomId: string;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Safe-area gutter the last row must clear. */
  bottomInset?: number;
  /** The archived fetch the footer reports and reveals. */
  archived?: ArchivedCornersState;
  onShowArchived?: () => void;
  /** Reads the next ten archived corners. */
  onMoreArchived?: () => void;
  /** Whose corners make up the Mine section. */
  viewerPubkey?: string;
  /** Clock for the closure stamps; defaults to now at paint. */
  nowMs?: number;
}) {
  const [mineOpen, setMineOpen] = useState(true);
  // Until the viewer folds Others, derive its default from the current list.
  // This also handles corners arriving after the initial empty render.
  const [othersOpen, setOthersOpen] = useState<boolean | undefined>();
  const [archivedOpen, setArchivedOpen] = useState(false);
  // FlatList compares `data` by identity, so it is rebuilt only when the
  // corners or a fold change, not on every parent render.
  const data = useMemo(() => {
    const mine = corners.filter((item) => isMineCorner(item, viewerPubkey));
    const others = corners.filter((item) => !isMineCorner(item, viewerPubkey));
    const section = (
      key: 'mine' | 'others',
      title: string,
      rows: readonly CornerListItem[],
      open: boolean,
    ): Entry[] =>
      rows.length
        ? [
            { kind: 'fold', key, label: `${title} · ${rows.length}`, open },
            ...(open ? rows.map((item) => ({ kind: 'row' as const, item })) : []),
          ]
        : [];
    return [
      ...section('mine', 'Mine', mine, mineOpen),
      ...section('others', 'Others', others, othersOpen ?? mine.length === 0),
    ];
  }, [corners, viewerPubkey, mineOpen, othersOpen]);
  const stampedAt = nowMs ?? Date.now();
  const archivedRows = archived.status === 'ready' && archivedOpen ? archived.corners : [];
  const more = archived.status === 'ready' ? archived.more : undefined;

  const row = (item: CornerListItem) => {
    const label = fullCornerTitle(parentRoomName, item.corner.name, item.corner.id);
    const display = cornerDisplayState(item);
    const owner = item.agent ?? item.initiator;
    const opener = owner ? `Opened by ${owner.name}` : item.latestMessage?.text;
    // An archived row answers "how long ago did this finish" before anything
    // else, so its closure age joins the same quiet line.
    const closed = cornerClosedStamp(item.closedAt, stampedAt);
    const line = [opener, display.detail, closed].filter(Boolean).join(' · ') || 'No activity yet';
    const open = () => {
      const humanUi = item.app?.manifest.humanUi;
      if (humanUi) {
        router.push({
          pathname: '/beeline/corner-app/[slug]',
          params: { slug: item.app!.manifest.slug, roomId: item.corner.id },
        });
        return;
      }
      router.push(cornerHref(item.corner.id, parentRoomId, item.corner.name, 'corners'));
    };
    return (
      <Pressable
        accessibilityLabel={`${label}. ${display.word}. ${line}`}
        accessibilityRole="button"
        onPress={open}
        style={styles.row}
        testID={`room-corner-${item.corner.id}`}
      >
        <IdentityMark
          kind={owner?.kind === 'agent' ? 'agent' : 'human'}
          seed={owner?.pubkey ?? item.corner.id}
          avatarUrl={owner?.avatar}
          face={owner?.face}
          name={owner?.name ?? 'Corner'}
          size={26}
        />
        <View style={styles.rowCopy}>
          {/* Captain 2026-09-20: a corner's name is never truncated. It
            wraps to as many lines as it needs and the row grows with it;
            uneven row heights are the accepted cost of printing the name
            in full. */}
          <Text style={styles.rowTitle}>{label}</Text>
          <Text numberOfLines={1} style={styles.agent}>
            {line}
          </Text>
        </View>
        {/* The state, twice over: the word carries it for everyone, the
          circle carries its motion for the glance. */}
        <Text
          style={[
            styles.state,
            display.tone === 'brass'
              ? styles.stateBrass
              : display.tone === 'ghost'
                ? styles.stateGhost
                : styles.stateQuiet,
          ]}
        >
          {display.word}
        </Text>
        <StateCircle state={display.visual} tone={display.tone} />
      </Pressable>
    );
  };

  const fold = (
    key: string,
    label: string,
    open: boolean,
    onPress: (() => void) | undefined,
    busy = false,
  ) => (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ expanded: open, busy }}
      disabled={busy}
      onPress={onPress}
      style={styles.more}
      testID={`room-corners-${key}`}
    >
      <Text style={styles.moreLabel}>{label}</Text>
      {busy ? (
        <SurfaceGlyphLoader compact testID={`room-corners-${key}-loading`} />
      ) : (
        <ChevronGlyph
          color={styles.chevron.color}
          direction={open ? 'up' : 'down'}
          size={CHEVRON_ROW_SIZE}
        />
      )}
    </Pressable>
  );

  return (
    <FlatList
      data={data}
      keyExtractor={(entry) => (entry.kind === 'fold' ? `fold-${entry.key}` : entry.item.corner.id)}
      refreshing={refreshing}
      onRefresh={onRefresh}
      contentContainerStyle={[
        data.length || archivedRows.length ? undefined : styles.emptyContainer,
        { paddingBottom: bottomInset },
      ]}
      testID="room-corners-list"
      renderItem={({ item: entry, index }) =>
        entry.kind === 'row' ? (
          <MaybeTourTarget
            enabled={index === data.findIndex((candidate) => candidate.kind === 'row')}
            tip="corner"
          >
            {row(entry.item)}
          </MaybeTourTarget>
        ) : (
          fold(entry.key, entry.label, entry.open, () =>
            (entry.key === 'mine' ? setMineOpen : setOthersOpen)(!entry.open),
          )
        )
      }
      ListFooterComponent={
        <View>
          {/* The fold for closed work, standing on every Room. The first
            open reads the first page; after that it only folds and unfolds.
            The archived rows hang off the footer rather than joining `data`
            because the fold has to precede them. */}
          {fold(
            'archived',
            archivedCornersLabel(archived),
            archivedOpen && archived.status === 'ready',
            () => {
              if (archived.status !== 'ready') onShowArchived?.();
              setArchivedOpen(archived.status !== 'ready' || !archivedOpen);
            },
            archived.status === 'loading',
          )}
          {archivedRows.map((item) => (
            <React.Fragment key={item.corner.id}>{row(item)}</React.Fragment>
          ))}
          {archivedOpen && archived.status === 'ready' && archived.next ? (
            <Pressable
              accessibilityLabel={
                more?.status === 'error' ? `${more.reason}. Tap to retry` : 'More archived corners'
              }
              accessibilityRole="button"
              disabled={more?.status === 'loading'}
              onPress={onMoreArchived}
              style={styles.more}
              testID="room-corners-archived-more"
            >
              <Text style={styles.moreLabel}>
                {more?.status === 'error' ? `${more.reason}. Tap to retry` : 'More'}
              </Text>
              {more?.status === 'loading' ? (
                <SurfaceGlyphLoader compact testID="room-corners-archived-more-loading" />
              ) : null}
            </Pressable>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        // A Room whose only work is closed is not an empty Room: once the
        // archived rows are on screen the invitation to start would be a lie.
        archivedRows.length ? null : (
          <View style={styles.empty} testID="room-corners-empty">
            <Text style={styles.emptyTitle}>No {CHANGES_LABEL} yet</Text>
            <Text style={styles.emptyText}>
              Ask an agent in {parentRoomName} to start work and its {CORNER_LABEL} opens here.
            </Text>
          </View>
        )
      }
    />
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    row: {
      minHeight: hull.layout.row,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      paddingHorizontal: hull.space.md,
      // `minHeight` is a floor, not a height: a wrapped name grows the row,
      // and this keeps its last line off the divider when it does.
      paddingVertical: hull.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    rowCopy: { flex: 1, minWidth: 0 },
    rowTitle: { ...Typography.default('semiBold'), ...hull.type.body, color: hull.textPrimary },
    agent: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.ledgerQuiet,
    },
    // F2: the four state words are four widths, so the cell is sized to the
    // longest of them and right-aligned. Without this the title truncates at a
    // different x on every row and the words do not read down one edge.
    state: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      minWidth: 64,
      textAlign: 'right',
    },
    stateBrass: { color: hull.accent },
    stateQuiet: { color: hull.ledgerQuiet },
    stateGhost: { color: hull.ledgerGhost },
    chevron: { color: hull.textMuted },
    more: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: hull.space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    moreLabel: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted, flex: 1 },
    emptyContainer: { flexGrow: 1 },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: hull.space.sm,
      padding: hull.space.lg,
    },
    emptyTitle: { ...Typography.default('semiBold'), ...hull.type.body, color: hull.textPrimary },
    emptyText: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      textAlign: 'center',
    },
  };
});
