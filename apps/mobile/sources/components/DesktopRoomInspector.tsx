import * as React from 'react';
import { FlatList, PanResponder, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { CornerListItem, RoomView } from '@beeline/buzz-client';
import type { RoomWorkflowListResult, RoomWorkflowView } from '@beeline/api-contract/phone';
import type { RoomViewClient } from '@/sync/transport/room-view-client';
import {
  clampDesktopPaneWidth,
  DESKTOP_INSPECTOR_DEFAULT_WIDTH,
  desktopComposerKeyAction,
  loadDesktopPaneWidth,
  saveDesktopPaneWidth,
} from '@/buzz/desktop-workbench-state';
import { compactRelativeTime, ledgerStamp } from '@/buzz/relative-time';
import { cornerDisplayState } from '@/buzz/corner-display-state';
import { foldSystemLines } from '@/buzz/system-lines';
import {
  createRoomMessageProjector,
  roomViewTranscriptMessages,
  type ChatDisplayMessage,
} from '@/buzz/room-view-presentation';
import { buildChannelReferenceIndex } from '@/buzz/channel-reference';
import { openExternalUrl } from '@/utils/open-external-url';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Modal } from '@/modal';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { isAgentTurnActive } from '@/buzz/agent-presence';
import { selectComposerAckPresentation } from '@/buzz/room-indicators';
import { TurnProgressLine } from '@/components/buzz/TurnProgressLine';
import {
  COMPOSER_MAX_INPUT_HEIGHT,
  COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
  ConversationComposer,
} from '@/components/buzz/ConversationComposer';
import {
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from '@/components/buzz/HullActionSheet';
import { LedgerRoomUpdate, LedgerSystemLine } from '@/components/buzz/Ledger';
import {
  DaemonFactCard,
  GitHubEventCard,
  NotificationLifecycleCard,
  OrdinaryLedgerMessage,
} from '@/app/(app)/beeline/chat/RoomMessageVariants';

type Props = {
  room: RoomView;
  client: RoomViewClient | null;
  overlay: boolean;
  selectedCornerId: string | null;
  onSelectCorner(cornerId: string | null): void;
  onClose(): void;
  onNewCorner(): void;
  onOpenRoster(): void;
};

const COMPOSER_MIN_HEIGHT = COMPOSER_SINGLE_LINE_INPUT_HEIGHT;
const COMPOSER_MAX_HEIGHT = COMPOSER_MAX_INPUT_HEIGHT;

function stateLine(corner: CornerListItem): string {
  return `${corner.status}${corner.reason ? ` · ${corner.reason}` : ''}`;
}

function age(corner: CornerListItem): string {
  return compactRelativeTime(corner.statusAt ?? corner.corner.updatedAt, Date.now());
}

function terminal(corner: CornerListItem): boolean {
  return corner.status === 'concluded' || corner.status === 'closed';
}

export function DesktopRoomInspector({
  room,
  client,
  overlay,
  selectedCornerId,
  onSelectCorner,
  onClose,
  onNewCorner,
  onOpenRoster,
}: Props) {
  const [detail, setDetail] = React.useState<RoomView | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [width, setWidth] = React.useState(DESKTOP_INSPECTOR_DEFAULT_WIDTH);
  const [showConcluded, setShowConcluded] = React.useState(false);
  const [reviewerOpen, setReviewerOpen] = React.useState(false);
  const [reviewerAgentId, setReviewerAgentId] = React.useState(room.room.reviewerAgentId);
  const [reviewerBusy, setReviewerBusy] = React.useState(false);
  const [reviewerError, setReviewerError] = React.useState<string | null>(null);
  const [workflowList, setWorkflowList] = React.useState<RoomWorkflowListResult | null>(null);
  const [workflowLoading, setWorkflowLoading] = React.useState(false);
  const [workflowError, setWorkflowError] = React.useState<string | null>(null);
  const [workflowRunning, setWorkflowRunning] = React.useState<string | null>(null);
  const workflowLoadGeneration = React.useRef(0);
  const dragStart = React.useRef(width);

  React.useEffect(() => void loadDesktopPaneWidth('inspector').then(setWidth), []);
  React.useEffect(() => {
    setDetail(null);
    setShowConcluded(false);
    setReviewerAgentId(room.room.reviewerAgentId);
  }, [room.room.id, room.room.reviewerAgentId]);
  React.useEffect(() => {
    setWorkflowList(null);
    setWorkflowError(null);
    setWorkflowRunning(null);
  }, [room.room.id]);

  const canRunWorkflows =
    room.viewer.identity.kind === 'human' &&
    room.viewer.permissions.manage &&
    room.repositoryResolution === 'repository';
  const loadWorkflows = React.useCallback(async () => {
    const generation = ++workflowLoadGeneration.current;
    if (!canRunWorkflows) {
      setWorkflowList(null);
      setWorkflowError(null);
      return;
    }
    setWorkflowLoading(true);
    setWorkflowError(null);
    try {
      const result = await monolithPhoneOperation('listRoomWorkflows', { roomId: room.room.id });
      if (generation === workflowLoadGeneration.current) setWorkflowList(result);
    } catch (caught) {
      if (generation === workflowLoadGeneration.current) {
        setWorkflowError(`Could not load workflows: ${String(caught)}`);
      }
    } finally {
      if (generation === workflowLoadGeneration.current) setWorkflowLoading(false);
    }
  }, [canRunWorkflows, room.room.id]);

  React.useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

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

  const resizePan = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !overlay,
        onMoveShouldSetPanResponder: (_, gesture) => !overlay && Math.abs(gesture.dx) > 2,
        onPanResponderGrant: () => {
          dragStart.current = width;
        },
        onPanResponderMove: (_, gesture) =>
          setWidth(clampDesktopPaneWidth('inspector', dragStart.current - gesture.dx)),
        onPanResponderRelease: (_, gesture) => {
          const next = clampDesktopPaneWidth('inspector', dragStart.current - gesture.dx);
          setWidth(next);
          void saveDesktopPaneWidth('inspector', next);
        },
      }),
    [overlay, width],
  );

  const active = room.corners.filter((corner) => !terminal(corner));
  const concluded = room.corners.filter(terminal);
  const summary = room.corners.find((corner) => corner.corner.id === selectedCornerId);
  const agents = room.members.filter((member) => member.identity.kind === 'agent');
  const people = room.members.filter((member) => member.identity.kind === 'human');
  const reviewer = agents.find(({ identity }) => identity.pubkey === reviewerAgentId)?.identity;

  const changeReviewer = React.useCallback(
    async (next: string | null) => {
      setReviewerOpen(false);
      if (!room.viewer.permissions.manage || (reviewerAgentId ?? null) === next) return;
      setReviewerBusy(true);
      setReviewerError(null);
      try {
        await monolithPhoneOperation('updateRoom', { roomId: room.room.id, reviewerAgentId: next });
        setReviewerAgentId(next ?? undefined);
      } catch (caught) {
        setReviewerError(`Could not change Room reviewer: ${String(caught)}`);
      } finally {
        setReviewerBusy(false);
      }
    },
    [reviewerAgentId, room.room.id, room.viewer.permissions.manage],
  );

  const runWorkflow = React.useCallback(
    async (workflow: RoomWorkflowView) => {
      if (!workflowList || workflowRunning) return;
      const confirmed = await Modal.confirm(
        `Run ${workflow.name}?`,
        `Run ${workflow.name} on ${workflowList.defaultBranch}?`,
        { cancelText: 'Cancel', confirmText: 'Run' },
      );
      if (!confirmed) return;
      setWorkflowRunning(workflow.name);
      setWorkflowError(null);
      try {
        await monolithPhoneOperation('dispatchRoomWorkflow', {
          roomId: room.room.id,
          workflowName: workflow.name,
        });
        await loadWorkflows();
      } catch (caught) {
        setWorkflowError(`Could not run ${workflow.name}: ${String(caught)}`);
      } finally {
        setWorkflowRunning(null);
      }
    },
    [loadWorkflows, room.room.id, workflowList, workflowRunning],
  );

  return (
    <View
      style={[styles.inspector, { width }, overlay && styles.overlay]}
      testID={overlay ? 'desktop-inspector-overlay' : 'desktop-inspector'}
    >
      {!overlay && (
        <View
          {...resizePan.panHandlers}
          style={styles.resizer}
          testID="desktop-inspector-resizer"
        />
      )}
      {selectedCornerId ? (
        <CornerCockpit
          detail={detail}
          loading={loading}
          summary={summary}
          onBack={() => onSelectCorner(null)}
          onOpenCorner={onSelectCorner}
          onRefresh={refreshCorner}
        />
      ) : (
        <>
          <View style={styles.header} testID="desktop-work-overview-header">
            <View style={styles.headerButton} />
            <View style={styles.headerCopy}>
              <Text numberOfLines={1} style={styles.headerTitle}>
                #{room.room.name}
              </Text>
              <Text style={styles.headerMeta}>work</Text>
            </View>
            <Pressable
              accessibilityLabel="Close work pane"
              onPress={onClose}
              style={styles.headerButton}
              testID="desktop-inspector-close"
            >
              <Text style={styles.headerGlyph}>×</Text>
            </Pressable>
          </View>
          <FlatList
            data={[...active, ...(showConcluded ? concluded : [])]}
            keyExtractor={(corner) => corner.corner.id}
            style={styles.scroll}
            contentContainerStyle={styles.content}
            ListHeaderComponent={
              <SectionHeader title="CORNERS" action="New ›" onAction={onNewCorner} />
            }
            renderItem={({ item }) => (
              <CornerRow corner={item} onPress={() => onSelectCorner(item.corner.id)} />
            )}
            ListFooterComponent={
              <>
                {concluded.length > 0 && !showConcluded && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setShowConcluded(true)}
                    style={styles.simpleRow}
                    testID="desktop-work-concluded"
                  >
                    <Text style={styles.simpleTitle}>Concluded · {concluded.length}</Text>
                    <Text style={styles.chevron}>›</Text>
                  </Pressable>
                )}
                {canRunWorkflows ? (
                  <>
                    <View style={styles.sectionGap} />
                    <SectionHeader title="WORKFLOWS" />
                    {workflowList?.workflows.map((workflow, index) => (
                      <WorkflowRow
                        key={`${workflow.name}-${index}`}
                        workflow={workflow}
                        busy={workflowRunning === workflow.name}
                        disabled={Boolean(workflowRunning)}
                        onPress={() => void runWorkflow(workflow)}
                      />
                    ))}
                    {workflowLoading && !workflowList ? (
                      <Text style={styles.empty}>Loading workflows…</Text>
                    ) : null}
                    {!workflowLoading && workflowList?.workflows.length === 0 ? (
                      <Text style={styles.empty}>No dispatchable workflows</Text>
                    ) : null}
                    {workflowError ? <Text style={styles.error}>{workflowError}</Text> : null}
                  </>
                ) : null}
                <View style={styles.sectionGap} />
                <SectionHeader title="MEMBERS" />
                <Pressable
                  accessibilityRole="button"
                  onPress={onOpenRoster}
                  style={styles.memberRow}
                  testID="desktop-work-members"
                >
                  <View style={styles.faces}>
                    {room.members.slice(0, 4).map(({ identity }) => (
                      <IdentityMark
                        key={identity.pubkey}
                        kind={identity.kind === 'agent' ? 'agent' : 'human'}
                        seed={identity.pubkey}
                        avatarUrl={identity.avatar}
                        face={identity.face}
                        name={identity.name}
                        size={22}
                      />
                    ))}
                  </View>
                  <Text style={styles.memberCount}>
                    {people.length} people · {agents.length} agents
                  </Text>
                  <Text style={styles.chevron}>›</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={!room.viewer.permissions.manage || reviewerBusy}
                  onPress={() => setReviewerOpen(true)}
                  style={styles.simpleRow}
                  testID="desktop-work-reviewer"
                >
                  <Text style={styles.simpleTitle}>Reviewer</Text>
                  <Text style={styles.simpleMeta}>
                    {reviewer ? `@${reviewer.handle ?? reviewer.name}` : 'None'} ›
                  </Text>
                </Pressable>
                {reviewerError ? <Text style={styles.error}>{reviewerError}</Text> : null}
              </>
            }
          />
        </>
      )}
      <HullActionSheetModal
        accessibilityLabel="Close reviewer picker"
        onClose={() => setReviewerOpen(false)}
        subtitle="This agent reviews every pull request opened from the Room."
        testID="desktop-work-reviewer-sheet"
        title={`Reviewer for #${room.room.name}`}
        visible={reviewerOpen}
      >
        <HullActionSheetRow
          disabled={reviewerBusy}
          label="None"
          onPress={() => void changeReviewer(null)}
          selected={!reviewerAgentId}
          testID="desktop-work-reviewer-none"
        />
        {agents.map(({ identity }) => (
          <HullActionSheetRow
            disabled={reviewerBusy}
            key={identity.pubkey}
            label={`@${identity.handle ?? identity.name}`}
            onPress={() => void changeReviewer(identity.pubkey)}
            selected={reviewerAgentId === identity.pubkey}
            testID={`desktop-work-reviewer-agent-${identity.pubkey}`}
          />
        ))}
        <HullActionSheetCancel onPress={() => setReviewerOpen(false)} />
      </HullActionSheetModal>
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

function CornerRow({ corner, onPress }: { corner: CornerListItem; onPress(): void }) {
  const display = cornerDisplayState(corner);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={styles.cornerRow}
      testID={`desktop-work-corner-${corner.corner.id}`}
    >
      <View style={styles.cornerCopy}>
        <Text style={styles.cornerTitle}>{corner.corner.name}</Text>
        <Text style={styles.objective}>{corner.corner.about ?? corner.corner.name}</Text>
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
      </View>
      <View style={styles.cornerEndcap}>
        <Text
          style={[styles.cornerStatus, display.needsYou && styles.cornerStatusNeedsYou]}
          testID={`desktop-work-corner-state-${corner.corner.id}`}
        >
          {display.word}
        </Text>
        <Text style={styles.chevron}>›</Text>
      </View>
    </Pressable>
  );
}

function WorkflowRow({
  workflow,
  busy,
  disabled,
  onPress,
}: {
  workflow: RoomWorkflowView;
  busy: boolean;
  disabled: boolean;
  onPress(): void;
}) {
  const run = workflow.lastRunAt
    ? `${compactRelativeTime(workflow.lastRunAt, Date.now())} · ${workflow.conclusion ?? 'running'}`
    : 'Never run';
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={styles.simpleRow}
      testID={`desktop-work-workflow-${workflow.name}`}
    >
      <View style={styles.workflowCopy}>
        <Text style={styles.simpleTitle}>{workflow.name}</Text>
        <Text style={styles.simpleMeta}>{run}</Text>
      </View>
      <Text style={styles.sectionAction}>{busy ? 'Running…' : 'Run ›'}</Text>
    </Pressable>
  );
}

function CornerCockpit({
  detail,
  loading,
  summary,
  onBack,
  onOpenCorner,
  onRefresh,
}: {
  detail: RoomView | null;
  loading: boolean;
  summary?: CornerListItem;
  onBack(): void;
  onOpenCorner(cornerId: string): void;
  onRefresh(): Promise<void>;
}) {
  const [input, setInput] = React.useState('');
  const [focused, setFocused] = React.useState(false);
  const [height, setHeight] = React.useState(COMPOSER_MIN_HEIGHT);
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [stopping, setStopping] = React.useState(false);
  const [now, setNow] = React.useState(Date.now);
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
            projector.project(roomViewTranscriptMessages(detail), detail.viewer.identity.pubkey),
          )
        : [],
    [detail, projector],
  );
  const channelIndex = React.useMemo(
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
      await onRefresh();
    } catch (caught) {
      setSendError(`Could not send message: ${String(caught)}`);
    } finally {
      setSending(false);
    }
  }, [detail, input, onRefresh, sending]);
  const renderMessage = React.useCallback(
    ({ item }: { item: ChatDisplayMessage }) => {
      const openUrl = (url: string) => void openExternalUrl(url).catch(() => undefined);
      if (item.corner) return null;
      if (item.roomUpdate)
        return (
          <LedgerRoomUpdate id={item.id} line={item.text} stamp={ledgerStamp(item.timestamp)} />
        );
      if (item.notificationLifecycleRun)
        return (
          <NotificationLifecycleCard
            message={item}
            onOpenCorner={onOpenCorner}
            onOpenUrl={openUrl}
          />
        );
      if (item.githubEvent) return <GitHubEventCard message={item} onOpenUrl={openUrl} />;
      if (item.daemonFact)
        return <DaemonFactCard message={item} onOpenCorner={() => undefined} onOpenUrl={openUrl} />;
      if (item.isSystemNotice)
        return (
          <LedgerSystemLine
            id={item.id}
            text={item.text}
            {...(item.systemEvent ? { event: item.systemEvent } : {})}
            stamp={ledgerStamp(item.timestamp)}
            onOpenUrl={openUrl}
          />
        );
      return (
        <OrdinaryLedgerMessage
          message={item}
          participantsHydrated
          viewerPubkey={detail?.viewer.identity.pubkey ?? ''}
          speakerWorking={false}
          continued={false}
          participantHandles={(detail?.members ?? []).flatMap(({ identity }) =>
            identity.handle ? [{ pubkey: identity.pubkey, handle: identity.handle }] : [],
          )}
          channelIndex={channelIndex}
          deliveryFailed={false}
          onChannelReference={() => undefined}
          onReply={() => undefined}
          onCopy={() => undefined}
          onRetry={() => undefined}
          onDismiss={() => undefined}
          desktopLayout
        />
      );
    },
    [channelIndex, detail, onOpenCorner],
  );
  const title = summary?.corner.name ?? detail?.room.name ?? 'Corner';
  const objective = summary?.corner.about ?? detail?.room.about ?? title;
  return (
    <View style={styles.cockpit} testID="desktop-work-cockpit">
      <View style={styles.header} testID="desktop-work-cockpit-header">
        <Pressable
          accessibilityLabel="Back to work overview"
          onPress={onBack}
          style={styles.headerButton}
        >
          <Text style={styles.headerGlyph}>‹</Text>
        </Pressable>
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
      </View>
      <Text style={styles.pinnedObjective} testID="desktop-work-objective">
        {objective}
      </Text>
      {loading || !detail ? (
        <Text style={styles.empty}>
          {loading ? 'Loading Corner…' : 'Corner details unavailable'}
        </Text>
      ) : (
        <FlatList
          data={messages}
          keyExtractor={(message) => message.id}
          renderItem={renderMessage}
          style={styles.transcript}
          contentContainerStyle={styles.transcriptContent}
          testID="desktop-work-corner-transcript"
        />
      )}
      {detail && !detail.room.archived ? (
        <View style={styles.cockpitComposer}>
          {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
          {ack && (
            <TurnProgressLine
              label={ack.label}
              startedAt={ack.startedAt}
              onStop={ack.stop ? () => void stop() : undefined}
              stopping={stopping}
              testID="desktop-work-corner-progress"
            />
          )}
          <ConversationComposer
            onStop={ack?.stop ? stop : undefined}
            running={Boolean(turn)}
            stopKey={ack?.turnKey}
            stopping={stopping}
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
  overlay: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 100,
    boxShadow: '-12px 0 28px rgba(0,0,0,0.28)',
  } as any,
  resizer: { position: 'absolute', left: -4, top: 0, bottom: 0, width: 8, zIndex: 4 },
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.divider,
  },
  cornerCopy: { flex: 1, minWidth: 0 },
  cornerTitle: { ...theme.buzz.type.bodyStrong, color: theme.colors.text },
  objective: { ...theme.buzz.type.meta, color: theme.colors.text, marginTop: 4 },
  cornerAgent: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7 },
  cornerMeta: { ...theme.buzz.type.machine, color: theme.colors.textSecondary, flex: 1 },
  cornerEndcap: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  cornerStatus: { ...theme.buzz.type.sectionHead, color: theme.colors.textSecondary },
  cornerStatusNeedsYou: { color: theme.colors.textLink },
  sectionGap: { height: 22 },
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
  simpleMeta: { ...theme.buzz.type.meta, color: theme.colors.textSecondary },
  workflowCopy: { flex: 1, minWidth: 0, paddingVertical: 8, gap: 2 },
  chevron: { ...theme.buzz.type.bodyStrong, color: theme.colors.textSecondary },
  memberRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.divider,
  },
  faces: { flexDirection: 'row', gap: 3 },
  memberCount: { ...theme.buzz.type.meta, color: theme.colors.text, flex: 1 },
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
  cockpitComposer: { paddingHorizontal: 16, paddingBottom: 12 },
  empty: { ...theme.buzz.type.meta, color: theme.colors.textSecondary, padding: 16 },
  error: {
    ...theme.buzz.type.meta,
    color: theme.buzz.danger,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
}));
