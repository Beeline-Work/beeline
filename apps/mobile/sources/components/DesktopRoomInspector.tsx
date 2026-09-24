import * as React from 'react';
import { FlatList, PanResponder, Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { CornerListItem, RoomView } from '@beeline/buzz-client';
import type { RoomViewClient } from '@/sync/transport/room-view-client';
import {
  clampDesktopPaneWidth,
  DESKTOP_INSPECTOR_DEFAULT_WIDTH,
  DESKTOP_INSPECTOR_MIN_WIDTH,
  DESKTOP_TRANSCRIPT_MIN_WIDTH,
  desktopComposerKeyAction,
  loadDesktopPaneWidth,
  saveDesktopPaneWidth,
} from '@/buzz/desktop-workbench-state';
import { compactRelativeTime, ledgerStamp } from '@/buzz/relative-time';
import { ledgerDayCaption, transcriptBylineOpeners } from '@/buzz/message-dates';
import { cornerDisplayState } from '@/buzz/corner-display-state';
import { inspectorCornerObjective, inspectorCornerWindow } from '@/buzz/inspector-corners';
import { displayGroupedCornerTitle } from '@/buzz/room-list-row';
import { foldSystemLines } from '@/buzz/system-lines';
import {
  createRoomMessageProjector,
  roomViewTranscriptMessages,
  type ChatDisplayMessage,
} from '@/buzz/room-view-presentation';
import { useRoomTranscriptHistory } from '@/buzz/use-room-transcript-history';
import { buildChannelReferenceIndex, type ChannelReferenceIndex, type ChannelReferenceTarget } from '@/buzz/channel-reference';
import { openExternalUrl } from '@/utils/open-external-url';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import {
  clearDesktopArtifactPane,
  currentDesktopArtifact,
  subscribeDesktopArtifact,
  type DesktopArtifactSelection,
} from '@/buzz/desktop-artifact-pane';
import { DesktopArtifactPane } from '@/components/buzz/DesktopArtifactPane';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { isAgentTurnActive } from '@/buzz/agent-presence';
import { scheduleAnimationFrame } from '@/buzz/host-scheduler';
import { selectComposerAckPresentation } from '@/buzz/room-indicators';
import { TURN_LINE_BOX_HEIGHT } from '@/buzz/room-bottom-chrome';
import { TurnProgressLine } from '@/components/buzz/TurnProgressLine';
import {
  COMPOSER_MAX_INPUT_HEIGHT,
  COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
  ConversationComposer,
} from '@/components/buzz/ConversationComposer';
import { LedgerRoomUpdate, LedgerSystemLine, withLedgerDayCaption } from '@/components/buzz/Ledger';
import {
  DaemonFactCard,
  GitHubEventCard,
  NotificationLifecycleCard,
  OrdinaryLedgerMessage,
} from '@/app/(app)/beeline/chat/RoomMessageVariants';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';

type Props = {
  room: RoomView;
  client: RoomViewClient | null;
  channelIndex?: ChannelReferenceIndex;
  onChannelReference?: (target: ChannelReferenceTarget, text?: string) => void;
  selectedCornerId: string | null;
  onSelectCorner(cornerId: string | null): void;
  onOpenInMain(cornerId: string): void;
  onClose(): void;
  onNewCorner(): void;
  /** Scroll the cockpit transcript to this durable id and inscribe it. */
  focusMessageId?: string | null;
};

const COMPOSER_MIN_HEIGHT = COMPOSER_SINGLE_LINE_INPUT_HEIGHT;
const COMPOSER_MAX_HEIGHT = COMPOSER_MAX_INPUT_HEIGHT;

function stateLine(corner: CornerListItem): string {
  return corner.state;
}

function age(corner: CornerListItem): string {
  return compactRelativeTime(corner.stateAt ?? corner.corner.updatedAt, Date.now());
}

function HeaderIconControl({
  label,
  glyph,
  onPress,
  testID,
}: {
  label: string;
  glyph: string;
  onPress(): void;
  testID: string;
}) {
  const control = (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.headerButton}
      testID={testID}
    >
      <Text style={styles.headerGlyph}>{glyph}</Text>
    </Pressable>
  );
  return Platform.OS === 'web'
    ? React.createElement('span', { title: label, style: { display: 'flex' } }, control)
    : control;
}

export function DesktopRoomInspector({
  room,
  client,
  channelIndex,
  onChannelReference,
  selectedCornerId,
  onSelectCorner,
  onOpenInMain,
  onClose,
  onNewCorner,
  focusMessageId,
}: Props) {
  const [detail, setDetail] = React.useState<RoomView | null>(null);
  const [corners, setCorners] = React.useState<readonly CornerListItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [width, setWidth] = React.useState(DESKTOP_INSPECTOR_DEFAULT_WIDTH);
  const [cornersExpanded, setCornersExpanded] = React.useState(false);
  const dragStart = React.useRef(width);
  const [artifact, setArtifact] = React.useState<DesktopArtifactSelection | null>(currentDesktopArtifact());
  React.useEffect(
    () => subscribeDesktopArtifact((selection) => setArtifact(selection)),
    [],
  );

  React.useEffect(() => void loadDesktopPaneWidth('inspector').then(setWidth), []);
  React.useEffect(() => {
    setDetail(null);
    setCorners([]);
    setCornersExpanded(false);
  }, [room.room.id]);

  React.useEffect(() => {
    if (!client) {
      setCorners([]);
      return;
    }
    let cancelled = false;
    void client
      .corners(room.room.id)
      .then((view) => {
        if (!cancelled) setCorners(view.corners);
      })
      .catch(() => {
        if (!cancelled) setCorners([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, room.room.id]);

  const refreshCorner = React.useCallback(async () => {
    if (client && selectedCornerId) setDetail(await client.room(selectedCornerId));
  }, [client, selectedCornerId]);

  React.useEffect(() => {
    let cancelled = false;
    if (!client || !selectedCornerId) {
      setDetail(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const load = () =>
      client.room(selectedCornerId).then((next) => {
        if (!cancelled) setDetail(next);
      });
    void load()
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    const poll = setInterval(() => void load().catch(() => undefined), 10_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [client, selectedCornerId]);

  // Mirrors the navigation divider in SidebarNavigator. The pane is the last
  // child of its row, so its layout x plus its width is the row's width.
  // Reserve DESKTOP_TRANSCRIPT_MIN_WIDTH for the transcript, but only when the
  // row is wide enough that doing so still leaves the pane its own minimum.
  const [rowWidth, setRowWidth] = React.useState<number | null>(null);
  const maxWidthForTranscript =
    rowWidth === null ? Number.POSITIVE_INFINITY : rowWidth - DESKTOP_TRANSCRIPT_MIN_WIDTH;
  const renderedWidth = clampDesktopPaneWidth(
    'inspector',
    maxWidthForTranscript >= DESKTOP_INSPECTOR_MIN_WIDTH
      ? Math.min(width, maxWidthForTranscript)
      : width,
  );
  // Read the latest width through a ref so the PanResponder is never rebuilt
  // mid-drag: on web, rebuilding it resets the gesture's move accounting.
  const renderedWidthRef = React.useRef(renderedWidth);
  renderedWidthRef.current = renderedWidth;
  const resizePan = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 2,
        onPanResponderGrant: () => {
          dragStart.current = renderedWidthRef.current;
        },
        onPanResponderMove: (_, gesture) =>
          setWidth(clampDesktopPaneWidth('inspector', dragStart.current - gesture.dx)),
        onPanResponderRelease: (_, gesture) => {
          const next = clampDesktopPaneWidth('inspector', dragStart.current - gesture.dx);
          setWidth(next);
          void saveDesktopPaneWidth('inspector', next);
        },
      }),
    [],
  );

  const cornerList = inspectorCornerWindow(corners, cornersExpanded);
  const summary = corners.find((corner) => corner.corner.id === selectedCornerId);

  return (
    <View
      style={[styles.inspector, { width: renderedWidth }]}
      onLayout={(event) => {
        const { x, width: laidOutWidth } = event.nativeEvent.layout;
        setRowWidth(Math.round(x + laidOutWidth));
      }}
      testID="desktop-inspector"
    >
      <View
        {...resizePan.panHandlers}
        accessibilityLabel="Resize work pane"
        style={styles.resizer}
        testID="desktop-inspector-resizer"
      />
      {artifact ? (
        <DesktopArtifactPane
          attachment={artifact.attachment}
          authorHandle={artifact.authorHandle}
          onClose={() => clearDesktopArtifactPane()}
        />
      ) : selectedCornerId ? (
        <CornerCockpit
          client={client}
          channelIndex={channelIndex}
          onChannelReference={onChannelReference}
          roomId={selectedCornerId}
          detail={detail}
          loading={loading}
          summary={summary}
          focusMessageId={focusMessageId}
          onOpenInMain={() => onOpenInMain(selectedCornerId)}
          onClose={onClose}
          onOpenCorner={onSelectCorner}
          onRefresh={refreshCorner}
        />
      ) : (
        <>
          <View style={styles.header} testID="desktop-work-corners-header">
            <View style={styles.headerButton} />
            <View style={styles.headerCopy}>
              <Text numberOfLines={1} style={styles.headerTitle}>
                #{room.room.name}
              </Text>
            </View>
            <HeaderIconControl
              label="Close work pane"
              glyph="×"
              onPress={onClose}
              testID="desktop-inspector-close"
            />
          </View>
          <FlatList
            data={[...cornerList.visible]}
            keyExtractor={(corner) => corner.corner.id}
            style={styles.scroll}
            contentContainerStyle={styles.content}
            ListHeaderComponent={
              <SectionHeader title="CORNERS" action="New ›" onAction={onNewCorner} />
            }
            renderItem={({ item }) => (
              <CornerRow
                corner={item}
                parentRoomName={room.room.name}
                viewerPubkey={room.viewer.identity.pubkey}
                onPress={() => onSelectCorner(item.corner.id)}
              />
            )}
            ListFooterComponent={
              cornerList.overflowLabel ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setCornersExpanded(true)}
                  style={styles.simpleRow}
                  testID="desktop-work-corners-more"
                >
                  <Text style={styles.simpleTitle}>{cornerList.overflowLabel}</Text>
                  <ChevronGlyph
                    color={styles.chevron.color}
                    direction="right"
                    size={CHEVRON_ROW_SIZE}
                  />
                </Pressable>
              ) : null
            }
          />
        </>
      )}
    </View>
  );
}

function SectionHeader({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action ? (
        <Pressable accessibilityRole="button" onPress={onAction} testID="desktop-work-new-corner">
          <Text style={styles.sectionAction}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function CornerRow({
  corner,
  parentRoomName,
  viewerPubkey,
  onPress,
}: {
  corner: CornerListItem;
  parentRoomName: string;
  viewerPubkey: string;
  onPress(): void;
}) {
  const display = cornerDisplayState(corner);
  const title = displayGroupedCornerTitle(parentRoomName, corner.corner.name, corner.corner.id);
  const objective = inspectorCornerObjective(title, corner.corner.about);
  const initiatedByViewer = corner.initiator?.pubkey === viewerPubkey;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={styles.cornerRow}
      testID={`desktop-work-corner-${corner.corner.id}`}
    >
      <View style={styles.cornerHeadline}>
        <Text
          style={[styles.cornerTitle, display.terminal ? styles.cornerTitleArchived : undefined]}
        >
          {title}
        </Text>
        <Text
          style={[
            styles.cornerStatus,
            display.status === 'working'
              ? styles.cornerStatusWorking
              : display.status === 'review'
                ? styles.cornerStatusReview
                : display.status === 'archived'
                  ? styles.cornerStatusArchived
                  : styles.cornerStatusWaiting,
          ]}
          testID={`desktop-work-corner-state-${corner.corner.id}`}
        >
          {display.word}
        </Text>
        {initiatedByViewer ? (
          <Text style={styles.cornerMe} testID={`desktop-work-corner-me-${corner.corner.id}`}>
            ME
          </Text>
        ) : null}
        <ChevronGlyph color={styles.chevron.color} direction="right" size={CHEVRON_ROW_SIZE} />
      </View>
      {objective ? (
        <Text
          ellipsizeMode="tail"
          numberOfLines={2}
          style={[styles.objective, display.terminal ? styles.objectiveArchived : undefined]}
          testID={`desktop-work-corner-objective-${corner.corner.id}`}
        >
          {objective}
        </Text>
      ) : null}
      <View style={styles.cornerAgent}>
        <IdentityMark
          kind={corner.agent?.kind === 'agent' ? 'agent' : 'human'}
          seed={corner.agent?.pubkey ?? corner.corner.id}
          avatarUrl={corner.agent?.avatar}
          face={corner.agent?.face}
          name={corner.agent?.name ?? 'Unassigned'}
          size={18}
        />
        <Text style={styles.cornerMeta}>
          {corner.agent ? `@${corner.agent.handle ?? corner.agent.name}` : 'Unassigned'} ·{' '}
          {age(corner)}
        </Text>
      </View>
    </Pressable>
  );
}

function scheduleFrame(callback: () => void) {
  if (!scheduleAnimationFrame(callback)) callback();
}

function messageMatchesFocus(message: ChatDisplayMessage, focusMessageId: string): boolean {
  return message.id === focusMessageId || message.relayId === focusMessageId;
}

function inspectorMessageKind(message: ChatDisplayMessage) {
  if (message.corner) return 'hidden';
  if (message.roomUpdate) return 'room-update';
  if (message.notificationLifecycleRun) return 'notification';
  if (message.githubEvent) return 'github';
  if (message.daemonFact) return 'daemon';
  if (message.isSystemNotice) return 'system';
  return 'ordinary';
}

function CornerCockpit({
  client,
  channelIndex: workspaceChannelIndex,
  onChannelReference,
  roomId,
  detail,
  loading,
  summary,
  focusMessageId,
  onOpenInMain,
  onClose,
  onOpenCorner,
  onRefresh,
}: {
  client: RoomViewClient | null;
  channelIndex?: ChannelReferenceIndex;
  onChannelReference?: (target: ChannelReferenceTarget, text?: string) => void;
  roomId: string;
  detail: RoomView | null;
  loading: boolean;
  summary?: CornerListItem;
  focusMessageId?: string | null;
  onOpenInMain(): void;
  onClose(): void;
  onOpenCorner(cornerId: string): void;
  onRefresh(): Promise<void>;
}) {
  const transcriptRef = React.useRef<FlatList<ChatDisplayMessage>>(null);
  const focusedAnchorRef = React.useRef<string | null>(null);
  const [input, setInput] = React.useState('');
  const [focused, setFocused] = React.useState(false);
  const [height, setHeight] = React.useState(COMPOSER_MIN_HEIGHT);
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [stopping, setStopping] = React.useState(false);
  const [now, setNow] = React.useState(Date.now);
  const {
    olderPages,
    status: historyStatus,
    loadOlder,
  } = useRoomTranscriptHistory({
    roomId,
    tailMessages: detail?.room.id === roomId ? detail.messages : undefined,
    roomClient: client,
    enabled: Boolean(focusMessageId && client),
    initialVisibleCount: 200,
  });
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const turn = detail?.latestAgentTurns.find((candidate) =>
    isAgentTurnActive(candidate, undefined, now),
  );
  const ack = selectComposerAckPresentation({
    isCorner: true,
    now,
    viewerPubkey: detail?.viewer.identity.pubkey,
    viewerRole: detail?.viewer.role,
    activeTurnPubkey: turn?.agentPubkey,
    activeTurnAgentPubkey: turn?.agentPubkey,
    activeTurnRequestId: turn?.requestId,
    activeTurnRequestedBy: turn?.requestedBy,
    activeTurnStartedAt: turn?.startedAt ?? turn?.createdAt,
    conversationIdentities: new Map(
      detail?.members.map(({ identity }) => [identity.pubkey, identity]),
    ),
  });
  React.useEffect(() => setStopping(false), [ack?.turnKey]);
  const stop = async () => {
    if (!ack?.stop || !detail || stopping) return false;
    setStopping(true);
    try {
      await monolithPhoneOperation('cancelAgentTurn', {
        roomId: detail.room.id,
        requestId: ack.stop.requestId,
        agentId: ack.stop.agentPubkey,
      });
      void onRefresh().catch(() => undefined);
      return true;
    } catch (error) {
      setStopping(false);
      setSendError(`Could not stop turn: ${String(error)}`);
      return false;
    }
  };
  const projector = React.useMemo(() => createRoomMessageProjector(), [detail?.room.id]);
  const messages = React.useMemo(
    () =>
      detail
        ? foldSystemLines(
            projector.project(
              roomViewTranscriptMessages({
                messages: [...olderPages.flat(), ...detail.messages],
                toolRows: detail.toolRows,
              }),
              detail.viewer.identity.pubkey,
            ),
          )
        : [],
    [detail, olderPages, projector],
  );
  React.useEffect(() => {
    focusedAnchorRef.current = null;
  }, [focusMessageId, roomId]);
  React.useEffect(() => {
    if (!focusMessageId || !detail || loading) return;
    const found = messages.some((message) => messageMatchesFocus(message, focusMessageId));
    if (found) return;
    if (historyStatus === 'idle') loadOlder(messages.length);
  }, [detail, focusMessageId, historyStatus, loadOlder, loading, messages]);
  React.useEffect(() => {
    if (!focusMessageId) return;
    const key = `${roomId}:${focusMessageId}`;
    if (focusedAnchorRef.current === key) return;
    const index = messages.findIndex((message) => messageMatchesFocus(message, focusMessageId));
    if (index < 0) return;
    focusedAnchorRef.current = key;
    scheduleFrame(() =>
      transcriptRef.current?.scrollToIndex({
        index,
        viewPosition: 0.35,
        animated: false,
      }),
    );
  }, [focusMessageId, messages, roomId]);
  const localChannelIndex = React.useMemo(
    () =>
      buildChannelReferenceIndex(
        [],
        detail
          ? [
              {
                channelId: detail.room.id,
                parentChannelId: detail.parent?.id ?? '',
                name: detail.room.name,
              },
            ]
          : [],
      ),
    [detail],
  );
  const channelIndex = workspaceChannelIndex ?? localChannelIndex;
  const send = React.useCallback(async () => {
    const text = input.trim();
    if (!text || !detail || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const identity = await loadBuzzIdentity();
      if (!identity) throw new Error('Beeline identity is unavailable');
      const transport = new BuzzRigTransport(identity);
      const event = await transport.composeMessage({ sessionId: detail.room.id, text });
      await transport.publishPreparedMessage(event);
      setInput('');
      setHeight(COMPOSER_MIN_HEIGHT);
      // The focus jump that put the reader up in this corner's history is
      // spent once they speak: mark it landed so the refresh below cannot pull
      // them back off the message they just sent, then land on the tail.
      if (focusMessageId) focusedAnchorRef.current = `${roomId}:${focusMessageId}`;
      await onRefresh();
      scheduleFrame(() => transcriptRef.current?.scrollToEnd({ animated: false }));
    } catch (caught) {
      setSendError(`Could not send message: ${String(caught)}`);
    } finally {
      setSending(false);
    }
  }, [detail, focusMessageId, input, onRefresh, roomId, sending]);
  const bylineOpeners = React.useMemo(
    () =>
      transcriptBylineOpeners(
        messages,
        (message) => inspectorMessageKind(message) === 'ordinary' && !message.isAgentActivity,
      ),
    [messages],
  );
  const renderMessage = React.useCallback(
    ({
      item,
      index,
    }: {
      item: ChatDisplayMessage;
      index: number;
    }): React.ReactElement | null => {
      const openUrl = (url: string) => void openExternalUrl(url).catch(() => undefined);
      const immediatelyPrecedingMessage = index > 0 ? messages[index - 1] : undefined;
      const kind = inspectorMessageKind(item);
      if (kind === 'hidden') return null;
      const node =
        kind === 'room-update' ? (
          <LedgerRoomUpdate id={item.id} line={item.text} stamp={ledgerStamp(item.timestamp)} />
        ) : kind === 'notification' ? (
          <NotificationLifecycleCard
            message={item}
            onOpenCorner={onOpenCorner}
            onOpenUrl={openUrl}
          />
        ) : kind === 'github' ? (
          <GitHubEventCard message={item} onOpenUrl={openUrl} />
        ) : kind === 'daemon' ? (
          <DaemonFactCard message={item} onOpenCorner={() => undefined} onOpenUrl={openUrl} />
        ) : kind === 'system' ? (
          <LedgerSystemLine
            id={item.id}
            text={item.text}
            {...(item.systemEvent ? { event: item.systemEvent } : {})}
            stamp={ledgerStamp(item.timestamp)}
            onOpenUrl={openUrl}
          />
        ) : (
          <OrdinaryLedgerMessage
            message={item}
            firstBylineOfDay={bylineOpeners.has(item.id)}
            participantsHydrated
            viewerPubkey={detail?.viewer.identity.pubkey ?? ''}
            speakerWorking={false}
            continued={false}
            {...(immediatelyPrecedingMessage ? { immediatelyPrecedingMessage } : {})}
            participantHandles={(detail?.members ?? []).flatMap(({ identity }) =>
              identity.handle ? [{ pubkey: identity.pubkey, handle: identity.handle }] : [],
            )}
            channelIndex={channelIndex}
            deliveryFailed={false}
            onChannelReference={onChannelReference ?? (() => undefined)}
            onReply={() => undefined}
            onCopy={() => undefined}
            onRetry={() => undefined}
            onDismiss={() => undefined}
            desktopLayout
          />
        );
      const captioned = withLedgerDayCaption(
        node,
        ledgerDayCaption(item.timestamp, immediatelyPrecedingMessage?.timestamp),
      ) as React.ReactElement | null;
      if (focusMessageId && messageMatchesFocus(item, focusMessageId)) {
        return (
          <View style={styles.focusedMessage} testID="desktop-work-focused-message">
            {captioned}
          </View>
        );
      }
      return captioned;
    },
    [bylineOpeners, channelIndex, detail, focusMessageId, messages, onOpenCorner, onChannelReference],
  );
  const title = summary?.corner.name ?? detail?.room.name ?? 'Corner';
  const objective = summary?.corner.about ?? detail?.room.about ?? title;
  return (
    <View style={styles.cockpit} testID="desktop-work-cockpit">
      <View style={styles.header} testID="desktop-work-cockpit-header">
        {summary?.agent ? (
          <IdentityMark
            kind={summary.agent.kind === 'agent' ? 'agent' : 'human'}
            seed={summary.agent.pubkey}
            avatarUrl={summary.agent.avatar}
            face={summary.agent.face}
            name={summary.agent.name}
            size={26}
          />
        ) : null}
        <View style={styles.headerCopy}>
          <Text numberOfLines={2} style={styles.headerTitle}>
            {title}
          </Text>
          <Text style={styles.headerMeta}>
            {summary
              ? `${stateLine(summary)} · @${summary.agent?.handle ?? summary.agent?.name ?? 'unassigned'} · ${age(summary)}`
              : 'loading'}
          </Text>
        </View>
        <HeaderIconControl
          label="Open in the main pane"
          glyph="⤢"
          onPress={onOpenInMain}
          testID="desktop-work-open-in-main"
        />
        <HeaderIconControl
          label="Close work pane"
          glyph="×"
          onPress={onClose}
          testID="desktop-work-cockpit-close"
        />
      </View>
      <Text style={styles.pinnedObjective} testID="desktop-work-objective">
        {objective}
      </Text>
      {loading || !detail ? (
        loading ? (
          <View style={styles.loadingBlock} testID="desktop-corner-loader">
            <SurfaceGlyphLoader />
          </View>
        ) : (
          <Text style={styles.empty}>Corner details unavailable</Text>
        )
      ) : (
        <FlatList
          ref={transcriptRef}
          data={messages}
          keyExtractor={(message) => message.id}
          renderItem={renderMessage}
          style={styles.transcript}
          contentContainerStyle={styles.transcriptContent}
          onScrollToIndexFailed={({ index }) => {
            scheduleFrame(() =>
              transcriptRef.current?.scrollToIndex({
                index,
                viewPosition: 0.35,
                animated: false,
              }),
            );
          }}
          testID="desktop-work-corner-transcript"
        />
      )}
      {detail && detail.room.archived === false ? (
        <View style={styles.cockpitComposer}>
          {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
          <View style={styles.cockpitStatusSlot} testID="desktop-work-corner-status-slot">
            {ack && (
              <TurnProgressLine
                label={ack.label}
                startedAt={ack.startedAt}
                onStop={ack.stop ? () => void stop() : undefined}
                stopping={stopping}
                testID="desktop-work-corner-progress"
              />
            )}
          </View>
          <ConversationComposer
            onStop={ack?.stop ? stop : undefined}
            value={input}
            height={height}
            maxHeight={COMPOSER_MAX_HEIGHT}
            focused={focused}
            disabled={sending}
            onBlur={() => setFocused(false)}
            onChangeText={setInput}
            onContentSizeChange={(event) =>
              setHeight(
                Math.min(
                  COMPOSER_MAX_HEIGHT,
                  Math.max(COMPOSER_MIN_HEIGHT, Math.ceil(event.nativeEvent.contentSize.height)),
                ),
              )
            }
            onFocus={() => setFocused(true)}
            onKeyPress={(event) => {
              if (
                desktopComposerKeyAction(
                  'web',
                  event.nativeEvent.key,
                  Boolean((event.nativeEvent as unknown as { shiftKey?: boolean }).shiftKey),
                ) === 'send'
              ) {
                event.preventDefault();
                void send();
              }
            }}
            onSend={() => void send()}
            testIDPrefix="desktop-work-corner"
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inspector: {
    height: '100%',
    backgroundColor: theme.colors.groupped.background,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.divider,
    position: 'relative',
  },
  resizer: {
    position: 'absolute',
    left: -3,
    top: 0,
    bottom: 0,
    width: 7,
    cursor: 'col-resize',
    zIndex: 4,
  } as any,
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
    paddingHorizontal: 8,
  },
  headerButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerGlyph: { ...theme.buzz.type.hero, color: theme.buzz.accent },
  headerCopy: { flex: 1, minWidth: 0 },
  headerTitle: { ...theme.buzz.type.bodyStrong, color: theme.colors.text },
  headerMeta: { ...theme.buzz.type.meta, color: theme.colors.textSecondary, marginTop: 2 },
  scroll: { flex: 1 },
  content: { padding: 14, paddingBottom: 40 },
  sectionHeader: {
    minHeight: 28,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 2,
  },
  sectionTitle: { ...theme.buzz.type.sectionHead, color: theme.colors.textSecondary },
  sectionAction: { ...theme.buzz.type.sectionHead, color: theme.buzz.accent },
  cornerRow: {
    minHeight: 88,
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.divider,
  },
  cornerHeadline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cornerTitle: {
    ...theme.buzz.type.bodyStrong,
    color: theme.colors.text,
    flex: 1,
    minWidth: 0,
    includeFontPadding: false,
  },
  cornerTitleArchived: { color: theme.colors.textSecondary },
  objective: { ...theme.buzz.type.meta, color: theme.colors.text, marginTop: 4 },
  objectiveArchived: { color: theme.colors.textSecondary },
  cornerAgent: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7 },
  cornerMe: {
    ...theme.buzz.type.sectionHead,
    color: theme.buzz.accent,
    includeFontPadding: false,
  },
  cornerMeta: { ...theme.buzz.type.machine, color: theme.colors.textSecondary, flex: 1 },
  cornerStatus: {
    ...theme.buzz.type.sectionHead,
    color: theme.colors.textSecondary,
    includeFontPadding: false,
  },
  cornerStatusWorking: { color: theme.buzz.ledgerQuiet },
  cornerStatusReview: { color: theme.buzz.ledgerQuiet },
  cornerStatusWaiting: { color: theme.buzz.accent },
  cornerStatusArchived: { color: theme.buzz.ledgerGhost },
  simpleRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.divider,
  },
  simpleTitle: { ...theme.buzz.type.meta, color: theme.colors.text, flex: 1 },
  // Colour only. The mark is drawn in its own box now, so the type role and
  // the font-padding correction it used to need are dead weight.
  chevron: { color: theme.colors.textSecondary },
  cockpit: { flex: 1 },
  pinnedObjective: {
    ...theme.buzz.type.meta,
    color: theme.colors.text,
    margin: 12,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.divider,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.colors.surface,
  },
  transcript: { flex: 1 },
  transcriptContent: { paddingHorizontal: 14, paddingVertical: 10, gap: 12 },
  focusedMessage: { backgroundColor: theme.buzz.bgHighlight },
  cockpitComposer: { paddingHorizontal: 16, paddingBottom: 12 },
  cockpitStatusSlot: { minHeight: TURN_LINE_BOX_HEIGHT, justifyContent: 'center' },
  empty: { ...theme.buzz.type.meta, color: theme.colors.textSecondary, padding: 16 },
  loadingBlock: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  error: {
    ...theme.buzz.type.meta,
    color: theme.buzz.danger,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
}));
