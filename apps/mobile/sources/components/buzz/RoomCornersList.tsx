import React, { useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router } from 'expo-router';
import type { CornerListItem } from '@beeline/buzz-client';
import { cornerTitle, type WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { isMineCorner } from '@/buzz/mine-corners';
import { cornerHref } from '@/buzz/corner-navigation';
import { cornerDisplayState } from '@/buzz/corner-display-state';
import { CornerWaitingPulse } from './CornerWaitingPulse';
import {
  archivedCornersLabel,
  cornerClosedStamp,
  type ArchivedCornersState,
} from '@/buzz/archived-corners';
import { CHANGES_LABEL, CORNER_LABEL } from '@/buzz/vocabulary';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { StateCircle } from '@/components/buzz/MonoHull';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { Typography } from '@/constants/Typography';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { Button } from '@/components/buzz/Button';
import { CornerObjectiveLine } from '@/components/buzz/CornerObjectiveLine';
import { inspectorCornerObjective } from '@/buzz/inspector-corners';

/**
 * The Room's dedicated corners index, in three folding sections: Mine (the
 * viewer's corners and any waiting on them) starts open and uncapped, Others
 * starts open when Mine is empty and otherwise folded, and Archived starts
 * folded and pages ten at a time from the server. Fold state lives only as
 * long as the screen does.
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
 *
 * On desktop the page has the width for more than a name, so each corner is
 * one cell instead: the corner's own agent and the full name as the title
 * line, the state on the right, and under them the same objective panel the
 * corner page opens with (objective, live workflow, Read brief). Waiting /
 * Mine / Others / All / Archived filters replace the folds and the archived
 * footer; All is the default so every corner in the Room stays one click
 * away. Archived reads its first page when first chosen.
 */
type DesktopFilter = 'waiting' | 'mine' | 'others' | 'all' | 'archived';

const DESKTOP_FILTERS: readonly { readonly key: DesktopFilter; readonly label: string; readonly empty: string }[] = [
  { key: 'waiting', label: 'Waiting', empty: 'No corner here is waiting.' },
  { key: 'mine', label: 'Mine', empty: 'None of these corners are yours.' },
  { key: 'others', label: 'Others', empty: 'Every corner here is yours.' },
  { key: 'all', label: 'All', empty: '' },
  { key: 'archived', label: 'Archived', empty: '' },
];

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
  onMoreOpen,
  moreOpen = false,
  viewerPubkey,
  nowMs,
  desktop = false,
  liveRuns,
  onOpenWorkflow,
  onOpenBrief,
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
  /** Reads the next page of open corners when the list reaches its end. */
  onMoreOpen?: () => void;
  /** A later open page exists, including when a desktop filter hides this page's rows. */
  moreOpen?: boolean;
  /** Whose corners make up the Mine section. */
  viewerPubkey?: string;
  /** Clock for the closure stamps; defaults to now at paint. */
  nowMs?: number;
  /** One cell per corner with filters, instead of the phone rows and folds. */
  desktop?: boolean;
  /** A corner's live saved-workflow runs, newest first; its desktop cell names the first. */
  liveRuns?: (cornerId: string) => readonly WorkflowRunSummaryView[];
  onOpenWorkflow?: (run: WorkflowRunSummaryView) => void;
  /** Opens a corner's brief; offered only on a corner that has one. */
  onOpenBrief?: (item: CornerListItem) => void;
}) {
  const [mineOpen, setMineOpen] = useState(true);
  // Until the viewer folds Others, derive its default from the current list.
  // This also handles corners arriving after the initial empty render.
  const [othersOpen, setOthersOpen] = useState<boolean | undefined>();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [filter, setFilter] = useState<DesktopFilter>('all');
  const scrolled = useRef(false);
  // FlatList compares `data` by identity, so it is rebuilt only when the
  // corners or a fold change, not on every parent render.
  const data = useMemo(() => {
    if (desktop) {
      const rows =
        filter === 'archived'
          ? archived.status === 'ready'
            ? archived.corners
            : []
          : corners.filter((item) =>
              filter === 'waiting'
                ? item.state === 'waiting'
                : filter === 'mine'
                  ? isMineCorner(item, viewerPubkey)
                  : filter === 'others'
                    ? !isMineCorner(item, viewerPubkey)
                    : true,
            );
      return rows.map((item): Entry => ({ kind: 'row', item }));
    }
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
  }, [corners, viewerPubkey, mineOpen, othersOpen, desktop, filter, archived]);
  const stampedAt = nowMs ?? Date.now();
  // On desktop the Archived filter carries the closed rows inside `data`.
  const archivedRows =
    !desktop && archived.status === 'ready' && archivedOpen ? archived.corners : [];
  const showMoreArchived = desktop ? filter === 'archived' : archivedOpen;
  const more = archived.status === 'ready' ? archived.more : undefined;

  const openCorner = (item: CornerListItem) => {
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

  const stateWord = (display: ReturnType<typeof cornerDisplayState>) => (
    <CornerWaitingPulse state={display.word}>
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
    </CornerWaitingPulse>
  );

  const ownerMark = (item: CornerListItem) => {
    const owner = item.agent ?? item.initiator;
    return (
      <IdentityMark
        kind={owner?.kind === 'agent' ? 'agent' : 'human'}
        seed={owner?.pubkey ?? item.corner.id}
        avatarUrl={owner?.avatar}
        face={owner?.face}
        name={owner?.name ?? 'Corner'}
        size={26}
      />
    );
  };

  // The desktop cell. The face is the corner's own agent, the one its page
  // header shows (`owner_agent_id`), falling back to the person who opened it.
  const cell = (item: CornerListItem) => {
    const label = cornerTitle(parentRoomName, item.corner.name, item.corner.id);
    const display = cornerDisplayState(item);
    const objective = inspectorCornerObjective(label, item.corner.about);
    const runs = liveRuns?.(item.corner.id) ?? [];
    return (
      <Pressable
        accessibilityLabel={`${label}. ${display.word}${objective ? `. ${objective}` : ''}`}
        accessibilityRole="button"
        onPress={() => openCorner(item)}
        style={({ pressed }) => [styles.cell, pressed && styles.cellPressed]}
        testID={`room-corner-${item.corner.id}`}
      >
        <View style={styles.cellRail} testID={`room-corner-rail-${item.corner.id}`} />
        <View style={styles.cellTitle}>
          {ownerMark(item)}
          <Text style={[styles.rowTitle, styles.cellName]}>{label}</Text>
          {stateWord(display)}
          <StateCircle state={display.visual} tone={display.tone} />
        </View>
        <CornerObjectiveLine
          desktop
          objective={objective}
          onOpenBrief={item.briefRevision && onOpenBrief ? () => onOpenBrief(item) : undefined}
          workflow={runs[0]}
          onOpenWorkflow={onOpenWorkflow}
          otherLiveRuns={runs.slice(1)}
          testID={`room-corner-objective-${item.corner.id}`}
        />
      </Pressable>
    );
  };

  const row = (item: CornerListItem) => {
    if (desktop) return cell(item);
    const label = cornerTitle(parentRoomName, item.corner.name, item.corner.id);
    const display = cornerDisplayState(item);
    const owner = item.agent ?? item.initiator;
    const opener = owner ? `Opened by ${owner.name}` : item.latestMessage?.text;
    // An archived row answers "how long ago did this finish" before anything
    // else, so its closure age joins the same quiet line.
    const closed = cornerClosedStamp(item.closedAt, stampedAt);
    const line = [opener, display.detail, closed].filter(Boolean).join(' · ') || 'No activity yet';
    return (
      <Pressable
        accessibilityLabel={`${label}. ${display.word}. ${line}`}
        accessibilityRole="button"
        onPress={() => openCorner(item)}
        style={styles.row}
        testID={`room-corner-${item.corner.id}`}
      >
        {ownerMark(item)}
        <View style={styles.rowCopy}>
          {/* Captain 2026-09-20: a corner's name is never truncated. It
            wraps to as many lines as it needs and the row grows with it;
            uneven row heights are the accepted cost of printing the name
            in full. Android's default highQuality break strategy can
            measure a title at the wrap point as two lines yet draw one,
            leaving an empty line; simple keeps measure and draw equal. */}
          <Text style={styles.rowTitle} textBreakStrategy="simple">
            {label}
          </Text>
          <Text numberOfLines={1} style={styles.agent}>
            {line}
          </Text>
        </View>
        {/* The state, twice over: the word carries it for everyone, the
          circle carries its motion for the glance. */}
        {stateWord(display)}
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
      onScroll={(event) => { if (event.nativeEvent.contentOffset.y > 20) scrolled.current = true; }}
      onEndReached={() => { if (scrolled.current) onMoreOpen?.(); }}
      onEndReachedThreshold={0.5}
      data={data}
      keyExtractor={(entry) => (entry.kind === 'fold' ? `fold-${entry.key}` : entry.item.corner.id)}
      refreshing={refreshing}
      onRefresh={onRefresh}
      contentContainerStyle={[
        data.length || archivedRows.length ? undefined : styles.emptyContainer,
        { paddingBottom: bottomInset },
      ]}
      testID="room-corners-list"
      ListHeaderComponent={
        desktop ? (
          <View style={styles.filters} testID="room-corners-filters">
            {DESKTOP_FILTERS.map((option) => {
              // Archived is not in the live read, so its count is known
              // only once a page has landed, and is a floor while more wait.
              const count =
                option.key === 'archived'
                  ? archived.status === 'ready'
                    ? `${archived.corners.length}${archived.next ? '+' : ''}`
                    : undefined
                  : option.key === 'waiting'
                    ? corners.filter((item) => item.state === 'waiting').length
                    : option.key === 'mine'
                      ? corners.filter((item) => isMineCorner(item, viewerPubkey)).length
                      : option.key === 'others'
                        ? corners.filter((item) => !isMineCorner(item, viewerPubkey)).length
                        : corners.length;
              return (
                <Button
                  key={option.key}
                  label={count === undefined ? option.label : `${option.label} · ${count}`}
                  variant={filter === option.key ? 'brass' : 'secondary'}
                  accessibilityState={{ selected: filter === option.key }}
                  onPress={() => {
                    if (
                      option.key === 'archived' &&
                      (archived.status === 'idle' || archived.status === 'error')
                    )
                      onShowArchived?.();
                    setFilter(option.key);
                  }}
                  testID={`room-corners-filter-${option.key}`}
                />
              );
            })}
          </View>
        ) : null
      }
      renderItem={({ item: entry, index }) =>
        entry.kind === 'row'
          ? row(entry.item)
          : fold(entry.key, entry.label, entry.open, () =>
              (entry.key === 'mine' ? setMineOpen : setOthersOpen)(!entry.open),
            )
      }
      ListFooterComponent={
        <View>
          {moreOpen ? <Button label="MORE OPEN CORNERS" variant="secondary"
            onPress={onMoreOpen} testID="room-corners-more-open" /> : null}
          {/* The fold for closed work, standing on every Room. The first
            open reads the first page; after that it only folds and unfolds.
            The archived rows hang off the footer rather than joining `data`
            because the fold has to precede them. */}
          {desktop
            ? null
            : fold(
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
          {showMoreArchived && archived.status === 'ready' && archived.next ? (
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
        archivedRows.length ? null : desktop && filter === 'archived' ? (
          // Loading, failed (the Archived filter retries), or genuinely empty.
          <View style={styles.archivedEmpty}>
            <Text style={styles.filterEmpty} testID="room-corners-filter-empty">
              {archivedCornersLabel(archived)}
            </Text>
            {archived.status === 'loading' ? (
              <SurfaceGlyphLoader compact testID="room-corners-archived-loading" />
            ) : null}
          </View>
        ) : desktop && corners.length > 0 ? (
          <Text style={styles.filterEmpty} testID="room-corners-filter-empty">
            {DESKTOP_FILTERS.find((option) => option.key === filter)?.empty}
          </Text>
        ) : (
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
    // Desktop: one cell per corner, hairline-divided like every index.
    cell: {
      paddingHorizontal: hull.space.md,
      paddingVertical: hull.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    cellRail: { position: 'absolute', left: 0, top: hull.space.sm, bottom: hull.space.sm, width: StyleSheet.hairlineWidth, backgroundColor: hull.borderStrong },
    cellPressed: { backgroundColor: hull.bgPressed },
    cellName: { flex: 1, minWidth: 0 },
    cellTitle: { flexDirection: 'row', alignItems: 'center', gap: hull.space.sm, minHeight: 44 },
    filters: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: hull.space.sm,
      paddingHorizontal: hull.space.md,
      paddingVertical: hull.space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    archivedEmpty: { flexDirection: 'row', alignItems: 'center' },
    filterEmpty: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.ledgerQuiet,
      padding: hull.space.md,
    },
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
