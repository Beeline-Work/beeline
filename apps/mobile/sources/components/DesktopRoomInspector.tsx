import * as React from 'react';
import { PanResponder, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomView } from '@beeline/buzz-client';
import type { RoomViewClient } from '@/sync/transport/room-view-client';
import {
  clampDesktopPaneWidth,
  DESKTOP_INSPECTOR_DEFAULT_WIDTH,
  loadDesktopPaneWidth,
  saveDesktopPaneWidth,
} from '@/buzz/desktop-workbench-state';
import { compactRelativeTime } from '@/buzz/relative-time';
import { openExternalUrl } from '@/utils/open-external-url';
import { MemberRosterRow } from '@/components/buzz/MemberRosterRow';

type Props = {
  room: RoomView;
  client: RoomViewClient | null;
  overlay: boolean;
  onClose(): void;
  onOpenCorner(cornerId: string): void;
};

function statusLine(room: RoomView): string {
  const lifecycle = room.cornerLifecycle;
  if (!lifecycle) return 'No repository lifecycle reported';
  const bits = [lifecycle.lifecycle.toUpperCase(), lifecycle.checks.toUpperCase()];
  if (lifecycle.pr) bits.push(`PR #${lifecycle.pr.number}`);
  return bits.join(' · ');
}

export function DesktopRoomInspector({ room, client, overlay, onClose, onOpenCorner }: Props) {
  const styles = stylesheet;
  const [selectedCornerId, setSelectedCornerId] = React.useState<string | null>(null);
  const [selectedCorner, setSelectedCorner] = React.useState<RoomView | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [width, setWidth] = React.useState(DESKTOP_INSPECTOR_DEFAULT_WIDTH);
  const dragStart = React.useRef(width);

  React.useEffect(() => {
    void loadDesktopPaneWidth('inspector').then(setWidth);
  }, []);
  React.useEffect(() => {
    setSelectedCornerId(null);
    setSelectedCorner(null);
  }, [room.room.id]);

  const selectCorner = React.useCallback(
    (cornerId: string) => {
      setSelectedCornerId(cornerId);
      setSelectedCorner(null);
      if (!client) return;
      setLoading(true);
      void client
        .room(cornerId)
        .then(setSelectedCorner)
        .catch(() => undefined)
        .finally(() => setLoading(false));
    },
    [client],
  );

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

  const detail = selectedCorner;
  const artifacts = React.useMemo(
    () =>
      detail
        ? [...detail.messages, ...(detail.toolRows ?? [])].flatMap(
            (message) => message.attachments ?? [],
          )
        : [],
    [detail],
  );
  const history = detail
    ? [...detail.messages, ...(detail.toolRows ?? [])].slice(-12).reverse()
    : [];

  return (
    <View
      style={[styles.inspector, { width }, overlay && styles.overlay]}
      testID={overlay ? 'desktop-inspector-overlay' : 'desktop-inspector'}
    >
      {!overlay && (
        <View
          {...resizePan.panHandlers}
          style={styles.resizer as any}
          testID="desktop-inspector-resizer"
        />
      )}
      <View style={styles.header}>
        {selectedCornerId ? (
          <Pressable
            accessibilityLabel="Back to Room inspector"
            onPress={() => {
              setSelectedCornerId(null);
              setSelectedCorner(null);
            }}
            style={styles.headerButton}
          >
            <Text style={styles.headerGlyph}>‹</Text>
          </Pressable>
        ) : (
          <View style={styles.headerButton} />
        )}
        <Text style={styles.title}>{selectedCornerId ? 'CORNER INSPECTOR' : 'ROOM INSPECTOR'}</Text>
        <Pressable
          accessibilityLabel="Close inspector"
          onPress={onClose}
          style={styles.headerButton}
          testID="desktop-inspector-close"
        >
          <Text style={styles.headerGlyph}>×</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {!selectedCornerId ? (
          <>
            <Section title="MEMBERS">
              {room.members.map((member) =>
                member.identity.kind === 'agent' ? (
                  <MemberRosterRow
                    avatarUrl={member.identity.avatar}
                    disabled
                    divider="top"
                    face={member.identity.face}
                    handle={member.identity.handle}
                    key={member.identity.pubkey}
                    kind="agent"
                    name={member.identity.name}
                    online={member.presence?.status === 'online'}
                    pubkey={member.identity.pubkey}
                    testID={`desktop-inspector-member-${member.identity.pubkey}`}
                  />
                ) : (
                  <MemberRosterRow
                    avatarUrl={member.identity.avatar}
                    disabled
                    divider="top"
                    face={member.identity.face}
                    handle={member.identity.handle}
                    key={member.identity.pubkey}
                    kind="human"
                    name={member.identity.name}
                    pubkey={member.identity.pubkey}
                    role={member.role}
                    testID={`desktop-inspector-member-${member.identity.pubkey}`}
                  />
                ),
              )}
            </Section>
            <Section title="OPEN CORNERS">
              {room.corners
                .filter((corner) => corner.status !== 'closed' && corner.status !== 'concluded')
                .map((corner) => (
                  <Pressable
                    key={corner.corner.id}
                    accessibilityRole="button"
                    onPress={() => selectCorner(corner.corner.id)}
                    style={styles.cornerRow}
                    testID={`desktop-inspector-corner-${corner.corner.id}`}
                  >
                    <Text numberOfLines={2} style={styles.cornerTitle}>
                      {corner.corner.about ?? corner.corner.name}
                    </Text>
                    <Text style={styles.meta}>
                      {corner.status.toUpperCase()} · {corner.agent?.name ?? 'UNASSIGNED'} ›
                    </Text>
                  </Pressable>
                ))}
              {!room.corners.some(
                (corner) => corner.status !== 'closed' && corner.status !== 'concluded',
              ) && <Text style={styles.empty}>No open Corners</Text>}
            </Section>
          </>
        ) : loading || !detail ? (
          <Text style={styles.empty}>
            {loading ? 'Loading Corner…' : 'Corner details unavailable'}
          </Text>
        ) : (
          <>
            <Section title="OBJECTIVE">
              <Text style={styles.objective}>{detail.room.about ?? detail.room.name}</Text>
            </Section>
            <Section title="PARTICIPANTS">
              {detail.members.map((member) => (
                <View key={member.identity.pubkey} style={styles.row}>
                  <Text style={styles.rowTitle}>{member.identity.name}</Text>
                  <Text style={styles.meta}>{member.identity.kind.toUpperCase()}</Text>
                </View>
              ))}
            </Section>
            <Section title="CURRENT ACTIVITY">
              <Text style={styles.objective}>
                {detail.latestAgentTurns.some((turn) => turn.status === 'working')
                  ? 'Agent working now'
                  : 'No active turn'}
              </Text>
              <Text style={styles.meta}>{statusLine(detail)}</Text>
            </Section>
            <Section title="BRANCH · PR · CHECKS">
              <Text selectable style={styles.objective}>
                {detail.cornerLifecycle?.branch ?? 'No branch reported'}
              </Text>
              {detail.cornerLifecycle?.pr && (
                <Pressable
                  onPress={() => void openExternalUrl(detail.cornerLifecycle!.pr!.url).catch(() => undefined)}
                >
                  <Text style={styles.link}>Open PR #{detail.cornerLifecycle.pr.number} ↗</Text>
                </Pressable>
              )}
              <Text style={styles.meta}>
                {detail.cornerLifecycle?.checksSummary
                  ? `${detail.cornerLifecycle.checksSummary.total} checks · ${detail.cornerLifecycle.checksSummary.status}`
                  : (detail.cornerLifecycle?.checks ?? 'unknown')}
              </Text>
            </Section>
            <Section title="ARTIFACTS">
              {artifacts.map((artifact, index) => (
                <Pressable
                  key={`${artifact.url}:${index}`}
                  onPress={() =>
                    !artifact.expired && void openExternalUrl(artifact.url).catch(() => undefined)
                  }
                  style={styles.row}
                >
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {artifact.name}
                  </Text>
                  <Text style={styles.meta}>{artifact.expired ? 'EXPIRED' : 'OPEN ↗'}</Text>
                </Pressable>
              ))}
              {!artifacts.length && <Text style={styles.empty}>No artifacts attached</Text>}
            </Section>
            <Section title="HISTORY">
              {history.map((message) => (
                <View key={message.id} style={styles.historyRow}>
                  <Text style={styles.meta}>
                    {compactRelativeTime(message.createdAt, Date.now())} · {message.author.name}
                  </Text>
                  <Text numberOfLines={3} style={styles.historyText}>
                    {message.activity?.map((entry) => entry.title).join(' · ') || message.text}
                  </Text>
                </View>
              ))}
            </Section>
            <Section title="VIEW-ONLY">
              <Pressable
                accessibilityRole="button"
                onPress={() => onOpenCorner(detail.room.id)}
                style={styles.openButton}
                testID="desktop-inspector-open-corner"
              >
                <Text style={styles.openButtonText}>OPEN CORNER CONVERSATION</Text>
              </Pressable>
              <Text style={styles.consequence}>
                Shared actions such as closing the Corner stay in the Corner’s actions menu.
              </Text>
            </Section>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={stylesheet.section as any}>
      <Text style={stylesheet.sectionTitle as any}>{title}</Text>
      {children}
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
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
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
    paddingHorizontal: 8,
  },
  headerButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerGlyph: { ...theme.buzz.type.hero, color: theme.colors.text },
  title: { ...theme.buzz.type.sectionHead, flex: 1, textAlign: 'center', color: theme.colors.text },
  scroll: { flex: 1 },
  content: { padding: 16, gap: 22, paddingBottom: 40 },
  section: { gap: 8 },
  sectionTitle: { ...theme.buzz.type.sectionHead, color: theme.colors.textSecondary },
  row: { minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { ...theme.buzz.type.meta, flex: 1, color: theme.colors.text },
  meta: { ...theme.buzz.type.sectionHead, color: theme.colors.textSecondary },
  empty: { ...theme.buzz.type.meta, color: theme.colors.textSecondary },
  cornerRow: {
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
    gap: 5,
  },
  cornerTitle: { ...theme.buzz.type.bodyStrong, color: theme.colors.text },
  objective: { ...theme.buzz.type.meta, color: theme.colors.text },
  link: { ...theme.buzz.type.machine, color: theme.colors.textLink, marginTop: 4 },
  historyRow: { gap: 4, paddingBottom: 9 },
  historyText: { ...theme.buzz.type.meta, color: theme.colors.text },
  openButton: {
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.textLink,
    borderRadius: 7,
    alignItems: 'center',
  },
  openButtonText: { ...theme.buzz.type.sectionHead, color: theme.colors.textLink },
  consequence: { ...theme.buzz.type.meta, color: theme.colors.textSecondary },
}));
