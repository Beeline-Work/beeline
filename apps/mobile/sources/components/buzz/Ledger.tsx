import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useFonts } from 'expo-font';
// @ts-expect-error Metro resolves font assets to native asset modules.
import spaceGroteskMedium from '@/assets/fonts/SpaceGrotesk-Medium.ttf';
// @ts-expect-error Metro resolves font assets to native asset modules.
import ibmPlexMonoRegular from '@/assets/fonts/IBMPlexMono-Regular.ttf';
import { hasMessageRevealed, markMessageRevealed } from '@/buzz/message-reveal';
import { identityPalette, isGeneratedAgentAvatarUrl } from '@/buzz/identity-mark';
import { IdentityMark } from './IdentityMark';
import { InlineRow } from './IndexRow';
import { MonoMarkdown } from './MonoMarkdown';
import type { ChannelReferenceIndex, ChannelReferenceTarget } from '@/buzz/channel-reference';
import { styles, provisionalProseStyle, settledAgentProseStyle } from './Ledger-styles';
import { LedgerSteer, LedgerRoomUpdate, LedgerHistoryLine, LedgerSystemLine, LedgerDayCaption, withLedgerDayCaption, LedgerGhostLine, LedgerUntaggedHint } from './Ledger-ledger-steer';



/**
 * The one transcript primitive a Room and a Corner both render, in the
 * approved Editorial direction: ONE message size everywhere (16/~1.55), Space
 * Grotesk prose with IBM Plex Mono reserved for bylines, code, tool readouts,
 * and system lines. Hierarchy on a long agent turn comes from
 * brightness — a regular bright lead line, then regular secondary
 * prose — never from size. Same-speaker chunks use one compact vertical
 * rhythm; a new byline gets exactly twice that separation on its visual-top
 * edge so a voice change reads without speaker rails, bubbles, dividers, or
 * boxes. Extra air lives on that incoming edge, not on whichever outgoing
 * row happens to wear a byline — agents always re-announce, people often
 * don't, and those two speaker-change gaps must still match.
 *
 * Identity lives in the byline above every agent prose message and the first
 * message in a human run: the speaker's
 * 26px face tile, then the name in the identity's own hue at body size, the
 * quiet mono model metadata (`claude-opus-4-1`, or the `AGENT` fallback), and
 *         the mono stamp pinned right (clock, or `17 SEP 16:58` on a past-day
 * byline). A human message is plain body text — regular weight, primary tone,
 * same size as everything — so nothing but the brass byline name marks it as
 * the viewer's own.
 *
 * A Corner's top bar complements the message author; it never replaces the
 * author byline. A Room can hold several agents and several people. In either
 * surface, consecutive human messages may share a byline, while each agent
 * message states its own author. Same component, one prop.
 */

/** The right margin the ghosted stamp hangs in, clear of the flowing column. */
export const LEDGER_MARGINALIA_WIDTH = 36;


/** Transcript scale for the speaker's face tile. 26px is where the creature
 *  and the plate polarity (person vs agent) still resolve; an 8px dot never
 *  did, which is why the byline leads with a tile now. */
export const LEDGER_MARK_SIZE = 26;


/** The speaker's identity tile (`components/buzz/IdentityMark.tsx`), rendered
 *  at transcript scale in place of the generic byline dot. No new vocabulary:
 *  the same creature, hue and plate every other surface renders, gold ring
 *  while the agent works. */
export type LedgerBylineMark = {
  /** The speaker's stable seed (pubkey); same seed, same mark as everywhere. */
  seed: string;
  kind: 'agent' | 'human';
  /** The creature the speaker chose; absent → derived from the seed. */
  face?: string;
  /** Fixed server-owned connector logo; ordinary profile-photo URLs stay inert. */
  avatarUrl?: string;
  /** Agents only: working right now → the gold ring. */
  alive?: boolean;
};


/** The author byline; human continuations may omit it. */
export type LedgerByline = {
  onOpenProfile?: () => void;
  /** Claims a long press before the nested profile control can turn it into a tap. */
  onLongPress?: () => void;
  /** The voice's display name. */
  name?: string;
  /** Quiet agent metadata, e.g. `claude-opus-4-1` (or the `AGENT` fallback). */
  role?: string;
  /** The 24h clock stamp, mono. */
  stamp: string;
  /** True only for the viewer's own turn — switches the name to brass. */
  isViewer?: boolean;
  /** Private viewer state; the marker is status, never a separate control. */
  bookmarked?: boolean;
  /** Someone reported this message to the Beeline feedback loop. Shared room
   *  state, shown to every member as a quiet status word, never a control. */
  feedbackReported?: boolean;
  /** The speaker's identity mark. Omitted → the plain dot fallback renders. */
  mark?: LedgerBylineMark;
};


export type LedgerBodyProps = {
  itemId: string;
  bodyText: string | undefined;
  bodyTestID: string;
  /**
   * The message byline. Omitted only for a human continuation in the same run.
   */
  byline?: LedgerByline;
  /** True when this message continues the speaker run above it. */
  continued?: boolean;
  /**
   * The transcript lays rows out chronologically (desktop's ordinary flow)
   * rather than in the phone's inverted list, so a cell's layout-top — not its
   * layout-bottom — is its visual top. Speaker-change extra padding mirrors to
   * that visual-top edge.
   */
  chronological?: boolean;
  /**
   * The day caption already occupies the visual-top edge of this cell, so the
   * extra speaker-change padding would double the air.
   */
  precededByDayCaption?: boolean;
  marginalia?: React.ReactNode;
  replyReference?: React.ReactNode;
  /** An exact source jump for bodies whose whole quote is one control. */
  bodyAction?: {
    onPress(): void;
    accessibilityLabel: string;
    testID: string;
  };
  attachments?: React.ReactNode;
  /** The turn's tool run, collapsed — rendered under the prose it belongs to. */
  machineNoise?: React.ReactNode;
  /** A just-committed agent paragraph can reveal locally, even though the
   * relay publishes it atomically. */
  typewriter?: boolean;
  /**
   * The provisional text this durable reply is replacing (C98). Present only
   * when the reader was actually watching this turn stream, and spent once —
   * the settled words cross-fade up out of it instead of snapping over it.
   */
  settleFrom?: string;
  /** Handles backed by this message's real p-tags and current Room members. */
  mentionHandles?: readonly string[];
  /** Invoked when a resolved member mention is pressed. */
  onMention?: (handle: string) => void;
  /** Known rooms/corners of THIS workspace; omitted → no `#` reference links. */
  channelIndex?: ChannelReferenceIndex;
  /** Invoked when a recognized `#room`/`#room/corner` reference is pressed. */
  onChannelReference?: (target: ChannelReferenceTarget, text: string) => void;
  /** Opens a long code block and restores this row when the reader closes. */
  codeRoomId?: string;
  onOpenCode?: (messageId: string) => void;
};


/**
 * The transcript's one paragraph and speaker rhythm. Activity rows share this
 * with durable prose so crossing the streaming boundary cannot add a second
 * margin system.
 */
export function ledgerEntryRhythm({
  hasByline,
  chronological = false,
  precededByDayCaption = false,
}: {
  hasByline: boolean;
  chronological?: boolean;
  precededByDayCaption?: boolean;
}): StyleProp<ViewStyle> {
  return [
    styles.entry,
    hasByline &&
      !precededByDayCaption &&
      (chronological ? styles.entryWithBylineChronological : styles.entryWithByline),
  ];
}


const TYPEWRITER_MS_PER_CHARACTER = 10;


// Same inline constructs `parseMarkdownSpans` renders: bold, italic, link, code.
const LEAD_INLINE_PATTERN =
  /(\*\*(.*?)\*\*)|((?<!\*)\*(?!\*)(.*?)\*(?!\*))|(\[([^\]]+)\]\(([^)]+)\))|(`(.*?)`)/g;

const LEAD_ABBREVIATIONS = new Set(['e.g.', 'i.e.', 'vs.', 'cf.']);


/** A first line `parseMarkdownBlock` draws as its own block, not as prose. */
function isBlockLine(line: string, nextLine: string | undefined): boolean {
  const trimmed = line.trim();
  if (/^(#{1,6}\s|>|```|<options>|\d+\.\s|[-*+]\s)/.test(trimmed)) return true;
  if (trimmed === '---' || /^!\[[^\]]*\]\([^)]+\)$/.test(trimmed)) return true;
  const separator = nextLine?.trim() ?? '';
  return trimmed.includes('|') && /^[|\s\-:=]*$/.test(separator) && separator.includes('-');
}


/** True when the period at `end` closes an abbreviation or a bare number, not a sentence. */
function isFalseSentenceEnd(line: string, end: number): boolean {
  const lead = line.slice(0, end + 1).replace(/^["'(\[*_]+/, '');
  const word = lead
    .split(/\s/)
    .pop()!
    .replace(/^["'(\[*_]+/, '')
    .toLowerCase();
  if (LEAD_ABBREVIATIONS.has(word)) return true;
  // `etc.` ends a sentence unless the next word carries on in lower case.
  if (word === 'etc.') return /^\s+[a-z]/.test(line.slice(end + 1));
  return /^\d+\.$/.test(word) && lead === word;
}


/** Index just past the first real sentence end in `line` between `from` and `to`, or -1. */
function findSentenceEnd(line: string, from = 0, to = line.length): number {
  for (let index = from; index < to; index++) {
    if (!/[.!?]/.test(line[index])) continue;
    let end = index;
    while (/["')\]]/.test(line[end + 1] ?? '')) end++;
    if (/^(\s|$)/.test(line.slice(end + 1)) && !isFalseSentenceEnd(line, index)) return end + 1;
    index = end;
  }
  return -1;
}


/**
 * Split a turn into its emphasized lead sentence and regular body copy. The
 * two halves render as separate Markdown blocks, so the cut never lands inside
 * an inline construct, and a first line that is itself a block (list item,
 * heading, quote, table, image, options) is left whole.
 */
export function splitLeadSentence(text: string): [string, string] {
  const normalized = text.trim();
  if (!normalized) return ['', ''];
  const lines = normalized.split('\n');
  const firstLine = lines[0];
  if (isBlockLine(firstLine, lines[1])) return ['', normalized];
  const rest = lines.slice(1).join('\n');

  const constructs: { start: number; end: number; closesSentence: boolean }[] = [];
  for (const match of firstLine.matchAll(LEAD_INLINE_PATTERN)) {
    const visible = match[2] ?? match[4] ?? match[6] ?? '';
    constructs.push({
      start: match.index!,
      end: match.index! + match[0].length,
      closesSentence: match[8] === undefined && findSentenceEnd(visible) >= 0,
    });
  }

  let cut = -1;
  let index = 0;
  while (index < firstLine.length && cut < 0) {
    const construct = constructs.find((c) => c.start === index);
    if (construct) {
      index = construct.end;
      if (construct.closesSentence && /^(\s|$)/.test(firstLine.slice(index))) cut = index;
      continue;
    }
    const nextConstruct = constructs.find((c) => c.start > index)?.start ?? firstLine.length;
    const end = findSentenceEnd(firstLine, index, nextConstruct);
    if (end >= 0) cut = end;
    index = nextConstruct;
  }

  if (cut < 0) return [firstLine, rest.trim()];
  const remainder = [firstLine.slice(cut).trim(), rest].filter(Boolean).join('\n').trim();
  return [firstLine.slice(0, cut), remainder];
}


function TypewriterMarkdown({
  markdown,
  textStyle,
  testID,
  revealId,
  mentionHandles,
  onMention,
  channelIndex,
  onChannelReference,
  codeRoomId,
  onOpenCode,
}: {
  markdown: string;
  textStyle: React.ComponentProps<typeof MonoMarkdown>['textStyle'];
  testID: string;
  /** Stable id of the message this prose belongs to. The reveal plays at
   *  most once per id per app session — the SAME consume-once registry the
   *  entrance fade uses (`NewMessageMaterialize`) — so warm revalidation or a
   *  WS replay re-stamping `isNew` on room open cannot re-run it over
   *  already-seen text.
   */
  revealId?: string;
  mentionHandles?: readonly string[];
  onMention?: (handle: string) => void;
  channelIndex?: ChannelReferenceIndex;
  onChannelReference?: (target: ChannelReferenceTarget, text: string) => void;
  codeRoomId?: string;
  onOpenCode?: (messageId: string) => void;
}) {
  const reducedMotion = useReducedMotion();
  // Decided ONCE per mounted instance (same contract as `NewMessageMaterialize`):
  // a re-render while the reveal is running — presence tick, roster update —
  // must not flip the gate and cut the animation short. Cross-instance replay
  // (FlatList recycling the row, re-entering the Room) is closed by the shared
  // session reveal registry below.
  const animateRef = useRef<boolean | null>(null);
  if (animateRef.current === null) {
    animateRef.current =
      !reducedMotion && (revealId === undefined || !hasMessageRevealed(revealId));
  }
  const animate = animateRef.current;
  const opacity = useSharedValue(animate ? 0 : 1);
  const revealStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  // Mark after commit, not during render: a render React discards must not
  // spend the message's one reveal. Reduced motion shows everything at once,
  // but the reveal still counts — the message was seen.
  useEffect(() => {
    if (revealId !== undefined) markMessageRevealed(revealId);
  }, [revealId]);

  useEffect(() => {
    if (!animate) return;
    if (reducedMotion) {
      opacity.value = 1;
      return;
    }
    opacity.value = withTiming(1, {
      duration: Math.min(900, markdown.length * TYPEWRITER_MS_PER_CHARACTER),
      easing: Easing.out(Easing.cubic),
    });
    return () => cancelAnimation(opacity);
  }, [markdown, reducedMotion, animate, opacity]);

  return (
    <Animated.View style={revealStyle}>
      <MonoMarkdown
        markdown={markdown}
        mentionHandles={mentionHandles}
        onMention={onMention}
        channelIndex={channelIndex}
        onChannelReference={onChannelReference}
        codeSource={codeRoomId && revealId ? { roomId: codeRoomId, messageId: revealId } : undefined}
        onOpenCode={onOpenCode}
        testID={testID}
        textStyle={textStyle}
      />
    </Animated.View>
  );
}


/**
 * The ghosted margin: a fixed-width clock stamp, and (when a voice first
 * announces itself in a Room) an optional secondary detail under it.
 *
 * Hung in the right margin rather than set into the flow, so the centre stays a
 * clean column — editor line numbers, verse numbers. It is absolutely
 * positioned against the entry so it can never push the prose around, and it
 * takes the dimmest tier because none of it is information the reader is
 * looking for; it is information the reader occasionally checks.
 *
 * The Editorial direction folds the stamp into the byline for prose turns;
 * this gutter survives for the rows that keep the wider margin (the folded
 * tool run), where a stamp without a byline is still worth hanging.
 */
function LedgerMarginalia({
  stamp,
  detail,
  testID,
}: {
  stamp: string;
  /** Optional secondary detail for surfaces that have one. */
  detail?: string | null;
  testID?: string;
}) {
  if (!stamp && !detail) return null;
  return (
    <View pointerEvents="none" style={styles.marginalia} testID={testID}>
      {stamp ? (
        <Text numberOfLines={1} style={styles.marginaliaStamp}>
          {stamp}
        </Text>
      ) : null}
      {detail ? (
        <Text numberOfLines={1} style={styles.marginaliaDetail}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}


/** The one byline view: identity tile (or viewer dot) + name, role tag, stamp.
 *  Exported so the live draft lane's byline (`ActivityTimeline`) is exactly
 *  the settled row's byline — the tile, the name and the stamp are byte-for-byte
 *  the same, so NOTHING MOVES when a draft settles. What changes is the prose
 *  itself: provisional text is italic and quiet while it is being written, and
 *  cross-fades into the upright, content-toned reply (C98, `SettleFade`). */
export const LedgerBylineView = Byline;


const bylineFonts = {
  'SpaceGrotesk-Medium': spaceGroteskMedium,
  'IBMPlexMono-Regular': ibmPlexMonoRegular,
};


export function Byline({ byline }: { byline: LedgerByline }) {
  const [fontsReady] = useFonts(bylineFonts);
  const [wordsWidth, setWordsWidth] = useState<number>();
  // Android caches the fallback's width if an unloaded family is requested.
  // Changing the family explicitly when ready gives it a fresh measurement,
  // while keeping text readable and navigation mounted during font loading.
  const nameFont = fontsReady
    ? 'SpaceGrotesk-Medium'
    : Platform.OS === 'ios' ? 'System' : 'sans-serif';
  const metadataFont = fontsReady
    ? 'IBMPlexMono-Regular'
    : Platform.OS === 'ios' ? 'Courier' : 'monospace';
  const metadataFace = { fontFamily: metadataFont };
  // Reserve only the inter-item gaps. Metadata may use the remaining space,
  // but must never take it from a name that would otherwise fit.
  const nameLimit = wordsWidth == null ? '100%' : Math.max(0, wordsWidth - (byline.role ? 16 : 8));
  const mark = byline.mark;
  // Generated portraits sit on a fixed brass plate; use the theme's readable
  // brass for their names. Drawn faces keep their seed hue.
  const nameHue =
    mark && !byline.isViewer
      ? mark.kind === 'agent' && isGeneratedAgentAvatarUrl(mark.avatarUrl)
        ? styles.bylineNameViewer
        : { color: identityPalette(mark.seed, mark.kind).mid }
      : undefined;
  const Container = byline.onOpenProfile ? Pressable : View;
  return (
    <Container
      style={styles.byline}
      onPress={byline.onOpenProfile}
      onLongPress={byline.onLongPress}
      delayLongPress={byline.onLongPress ? 450 : undefined}
      hitSlop={byline.onOpenProfile ? { top: 9, bottom: 9 } : undefined}
      accessibilityRole={byline.onOpenProfile ? 'button' : undefined}
      accessibilityLabel={
        byline.onOpenProfile ? `Open ${byline.name ?? 'agent'} profile` : undefined
      }
      testID={byline.onOpenProfile ? 'chat-byline-profile' : undefined}
    >
      {mark ? (
        mark.kind === 'agent' ? (
          <IdentityMark
            seed={mark.seed}
            kind="agent"
            face={mark.face}
            avatarUrl={mark.avatarUrl}
            alive={Boolean(mark.alive)}
            size={LEDGER_MARK_SIZE}
            testID="chat-byline-mark"
          />
        ) : (
          <IdentityMark
            seed={mark.seed}
            kind="human"
            face={mark.face}
            avatarUrl={mark.avatarUrl}
            size={LEDGER_MARK_SIZE}
            testID="chat-byline-mark"
          />
        )
      ) : (
        <View
          style={[styles.bylineDot, byline.isViewer && styles.bylineDotViewer]}
          testID="chat-byline-dot"
        />
      )}
      {/* The three written parts sit on ONE baseline. They are set at two sizes
       *  in two faces (16px prose name, 13px `machine` tag and stamp), so centring
       *  them against each other leaves the small type floating half a line
       *  above the name's feet. Baseline alignment is the type rule; the mark
       *  is a picture, not a word, so it stays centred on the row — hence the
       *  nested row, which keeps `alignItems: 'center'` for the tile. */}
      <InlineRow
        style={styles.bylineWords}
        onLayout={(event) => setWordsWidth(event.nativeEvent.layout.width)}
        testID="chat-byline-words"
      >
        {byline.name ? (
          <Text
            numberOfLines={1}
            style={[
              styles.bylineName,
              { fontFamily: nameFont, maxWidth: nameLimit },
              nameHue,
              byline.isViewer && styles.bylineNameViewer,
            ]}
            testID="chat-byline-name"
          >
            {byline.name}
          </Text>
        ) : null}
        {byline.role ? (
          <Text
            ellipsizeMode="tail"
            numberOfLines={1}
            style={[styles.bylineTag, { fontFamily: metadataFont }]}
            testID="chat-byline-role"
          >
            {byline.role}
          </Text>
        ) : null}
        <InlineRow style={styles.bylineStatus} testID="chat-byline-status">
          {byline.feedbackReported ? (
            <Text
              accessibilityLabel="Reported to Beeline"
              numberOfLines={1}
              style={[styles.bylineStamp, metadataFace]}
              testID="chat-reported-marker"
            >
              Reported
            </Text>
          ) : null}
          {byline.bookmarked ? (
            <Ionicons
              accessibilityLabel="Bookmarked"
              color={styles.bookmarkMark.color}
              name="bookmark"
              size={11}
              testID="chat-bookmark-marker"
            />
          ) : null}
          <Text numberOfLines={1} style={[styles.bylineStamp, metadataFace]} testID="chat-byline-stamp">
            {byline.stamp}
          </Text>
        </InlineRow>
      </InlineRow>
    </Container>
  );
}


/** One short transition. Long enough to read as a dissolve, short enough that
 *  nobody waits for the words they were already reading. */
const SETTLE_MS = 220;


/**
 * The settle (C98): provisional out, settled in, at the same place on the page.
 *
 * The two layers overlap — the settled words drive the layout and the
 * provisional ghost is hung over them, absolutely, so nothing reflows while
 * the fade runs. When the reply differs from what was streamed (a retracted
 * sentence, a rewritten opening) the dissolve is what carries the reader
 * across the difference; when it is identical the reader sees only the tone
 * and the face resolve.
 *
 * Reduced motion settles instantly: no ghost, no steps, the provisional style
 * simply gives way to the settled one.
 */
function SettleFade({ provisional, children }: { provisional: string; children: React.ReactNode }) {
  const reducedMotion = useReducedMotion();
  const [complete, setComplete] = useState(reducedMotion);
  const progress = useSharedValue(reducedMotion ? 1 : 0);
  const settledStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const ghostStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
  useEffect(() => {
    if (reducedMotion) return;
    progress.value = withTiming(1, { duration: SETTLE_MS }, (finished) => {
      if (finished) runOnJS(setComplete)(true);
    });
    return () => cancelAnimation(progress);
  }, [reducedMotion, progress]);
  if (complete || reducedMotion) return <>{children}</>;
  return (
    <View testID="ledger-settle">
      <Animated.View style={settledStyle}>{children}</Animated.View>
      <Animated.View pointerEvents="none" style={[styles.settleGhost, ghostStyle]}>
        <MonoMarkdown
          markdown={provisional}
          testID="ledger-settle-ghost"
          textStyle={styles.ledgerProvisional}
        />
      </Animated.View>
    </View>
  );
}


/**
 * One turn, written straight onto the slab in the Editorial direction.
 *
 * An agent turn (`luminous`) may lead with one medium-weight line in the
 * primary tone — hierarchy by weight and brightness at the SAME size — then
 * flows in regular secondary prose. Everyone else writes plain body text at
 * the identical size. Every message keeps the same compact spacing; a human
 * continuation of the voice directly above simply omits the repeated byline.
 */
export function LedgerEntry({
  itemId,
  bodyText,
  bodyTestID,
  byline,
  continued = false,
  chronological = false,
  precededByDayCaption = false,
  luminous = false,
  replyReference,
  bodyAction,
  attachments,
  machineNoise,
  typewriter = false,
  settleFrom,
  mentionHandles,
  onMention,
  channelIndex,
  onChannelReference,
  codeRoomId,
  onOpenCode,
}: Omit<LedgerBodyProps, 'marginalia'> & { luminous?: boolean }) {
  const [leadText, remainingText] =
    bodyText && !continued && luminous ? splitLeadSentence(bodyText) : ['', bodyText ?? ''];
  const bodyTextStyle = luminous ? styles.ledgerTextLuminous : styles.ledgerText;
  // A settling reply was already typed out, live, in front of the reader. It
  // cross-fades; it never re-types itself.
  const typeOut = typewriter && !settleFrom;
  const body = (
    <>
      {leadText ? (
        <MonoMarkdown
          markdown={leadText}
          mentionHandles={mentionHandles}
          onMention={onMention}
          channelIndex={channelIndex}
          onChannelReference={onChannelReference}
          codeSource={codeRoomId ? { roomId: codeRoomId, messageId: itemId } : undefined}
          onOpenCode={onOpenCode}
          testID={remainingText ? `${bodyTestID}-lead` : bodyTestID}
          textStyle={styles.ledgerLead}
        />
      ) : null}
      {remainingText ? (
        typeOut ? (
          <TypewriterMarkdown
            markdown={remainingText}
            testID={bodyTestID}
            textStyle={bodyTextStyle}
            revealId={itemId}
            mentionHandles={mentionHandles}
            onMention={onMention}
            channelIndex={channelIndex}
            onChannelReference={onChannelReference}
            codeRoomId={codeRoomId}
            onOpenCode={onOpenCode}
          />
        ) : (
          <MonoMarkdown
            markdown={remainingText}
            mentionHandles={mentionHandles}
            onMention={onMention}
            channelIndex={channelIndex}
            onChannelReference={onChannelReference}
            codeSource={codeRoomId ? { roomId: codeRoomId, messageId: itemId } : undefined}
            onOpenCode={onOpenCode}
            testID={bodyTestID}
            textStyle={bodyTextStyle}
          />
        )
      ) : null}
    </>
  );
  return (
    <View
      style={ledgerEntryRhythm({
        hasByline: Boolean(byline),
        chronological,
        precededByDayCaption,
      })}
      testID={`chat-message-${itemId}`}
    >
      {byline ? <Byline byline={byline} /> : null}
      {replyReference}
      {bodyAction && (leadText || remainingText) ? (
        <Pressable
          accessibilityLabel={bodyAction.accessibilityLabel}
          accessibilityRole="button"
          onPress={bodyAction.onPress}
          testID={bodyAction.testID}
        >
          {settleFrom ? <SettleFade provisional={settleFrom}>{body}</SettleFade> : body}
        </Pressable>
      ) : settleFrom && (leadText || remainingText) ? (
        <SettleFade provisional={settleFrom}>{body}</SettleFade>
      ) : (
        body
      )}
      {machineNoise}
      {attachments}
    </View>
  );
}


export type SystemLineCutSearch = {
  key: string;
  mode: 'word' | 'char';
  candidates: number[];
  /** Highest candidate index known to fit, or -1. */
  lo: number;
  /** Lowest candidate index known not to fit. */
  hi: number;
};


export function startCutSearch(key: string, fullText: string, mode: 'word' | 'char'): SystemLineCutSearch {
  const candidates: number[] = [];
  for (let at = 1; at < fullText.length; at += 1) {
    if (mode === 'char' || (/\s/.test(fullText[at]!) && !/\s/.test(fullText[at - 1]!))) {
      candidates.push(at);
    }
  }
  if (!candidates.length && mode === 'word') return startCutSearch(key, fullText, 'char');
  return { key, mode, candidates, lo: -1, hi: candidates.length };
}


/** Drops trailing spaces and a dangling "·" so the ellipsis follows a word. */
export function closedCutLength(fullText: string, at: number): number {
  return fullText.slice(0, at).replace(/[\s·]+$/u, '').length;
}


export function webFitsTwoLines(element: HTMLElement): boolean | null {
  const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
  if (!Number.isFinite(lineHeight)) return null;
  return element.getBoundingClientRect().height <= lineHeight * 2 + 1;
}
export { LedgerSteer } from './Ledger-ledger-steer';
export { LedgerRoomUpdate } from './Ledger-ledger-steer';
export { LedgerHistoryLine } from './Ledger-ledger-steer';
export { LedgerSystemLine } from './Ledger-ledger-steer';
export { LedgerDayCaption } from './Ledger-ledger-steer';
export { withLedgerDayCaption } from './Ledger-ledger-steer';
export { LedgerGhostLine } from './Ledger-ledger-steer';
export { LedgerUntaggedHint } from './Ledger-ledger-steer';
export { provisionalProseStyle } from './Ledger-styles';
export { settledAgentProseStyle } from './Ledger-styles';
