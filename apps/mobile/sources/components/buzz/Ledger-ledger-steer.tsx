import { ErrorBanner } from './ErrorBanner';
import { LedgerDisclosure, LedgerLogGroup } from './LedgerDisclosure';
import { webhookCallerMessage } from '@/buzz/system-lines';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { MonoMarkdown } from './MonoMarkdown';
import type { SystemEvent, SystemSubject } from '@beeline/api-contract/phone';
import { LedgerBodyProps, ledgerEntryRhythm, Byline, SystemLineCutSearch, webFitsTwoLines, startCutSearch, closedCutLength } from './Ledger';
import { styles } from './Ledger';



/**
 * You, steering.
 *
 * Under the Editorial direction your message is NOT emphasized: plain body
 * text, regular weight, primary tone, one size — deliberately not bolded and
 * not enlarged. The ONLY thing marking the turn as yours is the byline's
 * brass dot and brass name. A run of your own messages keeps flowing as one
 * passage: no repeated byline, no internal divider.
 */
export function LedgerSteer({
  itemId,
  bodyText,
  bodyTestID,
  byline,
  chronological = false,
  precededByDayCaption = false,
  replyReference,
  bodyAction,
  attachments,
  mentionHandles,
  onMention,
  channelIndex,
  onChannelReference,
  codeRoomId,
  onOpenCode,
}: Omit<LedgerBodyProps, 'marginalia' | 'machineNoise' | 'typewriter' | 'settleFrom'>) {
  // Deliberately NO lead split here: a human message never takes the
  // emphasized lead treatment. Weight, size, and tone are exactly the agent
  // body's; ownership reads from the byline alone.
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
      {bodyText ? (
        bodyAction ? (
          <Pressable
            accessibilityLabel={bodyAction.accessibilityLabel}
            accessibilityRole="button"
            onPress={bodyAction.onPress}
            testID={bodyAction.testID}
          >
            <MonoMarkdown
              markdown={bodyText}
              mentionHandles={mentionHandles}
              onMention={onMention}
              channelIndex={channelIndex}
              onChannelReference={onChannelReference}
              codeSource={codeRoomId ? { roomId: codeRoomId, messageId: itemId } : undefined}
              onOpenCode={onOpenCode}
              textStyle={styles.steerText}
              testID={bodyTestID}
            />
          </Pressable>
        ) : (
          <MonoMarkdown
            markdown={bodyText}
            mentionHandles={mentionHandles}
            onMention={onMention}
            channelIndex={channelIndex}
            onChannelReference={onChannelReference}
            codeSource={codeRoomId ? { roomId: codeRoomId, messageId: itemId } : undefined}
            onOpenCode={onOpenCode}
            textStyle={styles.steerText}
            testID={bodyTestID}
          />
        )
      ) : null}
      {attachments}
    </View>
  );
}


/**
 * One derived Room-state notice. It is metadata, not a speaker turn: no
 * avatar, byline, rule, fill, or card. The optional landed-work digest is the
 * sole content-tier line and reuses relay copy rather than generating prose.
 */
export function LedgerRoomUpdate({
  id,
  line,
  stamp,
  digest,
  tone = 'quiet',
}: {
  id: string;
  line: string;
  stamp: string;
  digest?: string;
  tone?: 'quiet' | 'brass';
}) {
  return (
    <View style={styles.roomUpdate} testID={`room-update-${id}`}>
      <Text
        numberOfLines={1}
        style={
          tone === 'brass'
            ? [styles.roomUpdateLine, styles.roomUpdateLineBrass]
            : styles.roomUpdateLine
        }
        testID={`room-update-line-${id}`}
      >
        {line}
      </Text>
      <Text numberOfLines={1} style={styles.roomUpdateStamp} testID={`room-update-stamp-${id}`}>
        {stamp}
      </Text>
      {digest ? (
        <Text numberOfLines={2} style={styles.roomUpdateDigest} testID={`room-update-digest-${id}`}>
          {digest}
        </Text>
      ) : null}
    </View>
  );
}


/** Paging state belongs inside the transcript as one quiet line, never a card. */
export function LedgerHistoryLine({ text, onPress }: { text: string; onPress?: () => void }) {
  const line = <Text style={styles.historyLineText}>{text}</Text>;
  return onPress ? (
    <View style={styles.historyFailure}>
      <ErrorBanner inline title={text.replace(' · tap to retry', '')} onRetry={onPress}
        retryTestID="transcript-history-retry" />
    </View>
  ) : (
    <View style={styles.historyLine} testID="transcript-history-status">
      {line}
    </View>
  );
}


/**
 * The one renderer for a server-phrased system line (`buzz/system-lines.ts`):
 * `<subject> <verb>[ <object>][ · <consequence>]` in the quiet `meta` role,
 * no avatar, the stamp pinned right. Names are brass and tappable; an object
 * with a URL is a link. Every message remains a separate row. A row
 * from before the grammar has no event and shows its text verbatim.
 */
export function LedgerSystemLine({
  id,
  text,
  event,
  stamp,
  onOpenIdentity,
  onOpenUrl,
  onOpenBrief,
}: {
  id: string;
  text: string;
  event?: SystemEvent;
  stamp: string;
  onOpenIdentity?: (identityId: string) => void;
  onOpenUrl?: (url: string) => void;
  /** Opens the corner's latest brief; a revision notice links to it. */
  onOpenBrief?: () => void;
}) {
  const callerMessage = webhookCallerMessage(event);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const [search, setSearch] = useState<SystemLineCutSearch | null>(null);
  const [cut, setCut] = useState<{ key: string; at: number } | null>(null);
  const measurementRef = useRef<Text>(null);
  const probeRef = useRef<Text>(null);
  const fullText = event
    ? `${event.subject.name} ${event.verb}${event.object?.text ? ` ${event.object.text}` : ''}${event.consequence ? ` · ${event.consequence}` : ''}`
    : text;
  const measureWebOverflow = () => {
    const element = measurementRef.current as unknown as HTMLElement | null;
    if (element) setOverflows(webFitsTwoLines(element) === false);
  };
  useEffect(() => {
    setExpanded(false);
    if (Platform.OS === 'web') measureWebOverflow();
  }, [id, fullText]);
  // The closed line ends in "… more" on its second line. Text clamping cannot
  // append after its ellipsis, so a hidden probe finds the longest cut that
  // still fits: word ends first, single characters for one unbroken word.
  const cutKey = `${fullText}\n${width}`;
  const cutAt = cut?.key === cutKey ? cut.at : null;
  useEffect(() => {
    if (!overflows || width === null || cutAt !== null || search?.key === cutKey) return;
    const started = startCutSearch(cutKey, fullText, 'word');
    if (started.candidates.length) setSearch(started);
    else setCut({ key: cutKey, at: fullText.length });
  }, [overflows, width, cutAt, search?.key, cutKey, fullText]);
  const probing =
    search?.key === cutKey && cutAt === null && search.hi - search.lo > 1 ? search : null;
  const probeIndex = probing ? (probing.lo + probing.hi) >> 1 : null;
  const probeCandidate =
    probing && probeIndex !== null ? probing.candidates[probeIndex] : null;
  const settleProbe = (fits: boolean) => {
    if (!probing || probeIndex === null) return;
    const lo = fits ? probeIndex : probing.lo;
    const hi = fits ? probing.hi : probeIndex;
    if (hi - lo > 1) setSearch({ ...probing, lo, hi });
    else if (lo >= 0) setCut({ key: cutKey, at: probing.candidates[lo] });
    else if (probing.mode === 'word') setSearch(startCutSearch(cutKey, fullText, 'char'));
    else setCut({ key: cutKey, at: probing.candidates[0] ?? 1 });
  };
  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || probeCandidate === null) return;
    const element = probeRef.current as unknown as HTMLElement | null;
    const fits = element ? webFitsTwoLines(element) : null;
    if (fits !== null) settleProbe(fits);
  }, [probeCandidate, cutKey]);
  const name = (subject: SystemSubject, index: number) => (piece: string) => (
    <Text
      key={`${subject.id ?? subject.name}-${index}`}
      style={styles.systemLineName}
      onPress={
        subject.id && onOpenIdentity
          ? (event) => {
              event.stopPropagation();
              onOpenIdentity(subject.id!);
            }
          : undefined
      }
      testID={`system-line-name-${id}-${index}`}
    >
      {piece}
    </Text>
  );
  // Each segment renders any prefix of its text, so the closed cut keeps names and links.
  const segments: { text: string; render?: (piece: string) => React.ReactNode }[] = [];
  if (event) {
    segments.push(
      { text: event.subject.name, render: name(event.subject, 0) },
      { text: ` ${event.verb}` },
    );
    const object = event.object;
    if (object?.text) {
      segments.push({ text: ' ' });
      // The brief keeps no history on the phone: any revision notice opens
      // the latest brief.
      const briefRevision =
        event.verb === 'revised the corner brief' && /^Revision [1-9]\d*$/.test(object.text);
      if (briefRevision && onOpenBrief) {
        segments.push({
          text: object.text,
          render: (piece) => (
            <Text
              key="object"
              style={styles.systemLineLink}
              accessibilityRole="link"
              onPress={(event) => {
                event.stopPropagation();
                onOpenBrief();
              }}
              testID={`system-line-object-${id}`}
            >
              {piece}
            </Text>
          ),
        });
      } else if (object.id) {
        segments.push({
          text: object.text,
          render: (piece) => (
            <Text
              key="object"
              style={styles.systemLineName}
              onPress={
                onOpenIdentity
                  ? (event) => {
                      event.stopPropagation();
                      onOpenIdentity(object.id!);
                    }
                  : undefined
              }
              testID={`system-line-object-${id}`}
            >
              {piece}
            </Text>
          ),
        });
      } else if (object.url) {
        segments.push({
          text: object.text,
          render: (piece) => (
            <Text
              key="object"
              style={styles.systemLineLink}
              onPress={
                onOpenUrl
                  ? (event) => {
                      event.stopPropagation();
                      onOpenUrl(object.url!);
                    }
                  : undefined
              }
              testID={`system-line-object-${id}`}
            >
              {piece}
            </Text>
          ),
        });
      } else {
        segments.push({ text: object.text });
      }
    }
    if (event.consequence) segments.push({ text: ` · ${event.consequence}` });
  } else {
    segments.push({ text });
  }
  const renderSegments = (length = fullText.length) => {
    const nodes: React.ReactNode[] = [];
    let left = length;
    for (const segment of segments) {
      if (left <= 0) break;
      const piece = segment.text.slice(0, left);
      left -= piece.length;
      nodes.push(segment.render ? segment.render(piece) : piece);
    }
    return nodes;
  };
  // A non-breaking space binds the word to the text, so it never sits alone on a new line.
  const toggleWord = (word: 'more' | 'less') => (
    <Text key="toggle" style={styles.systemLineToggle} testID={`system-line-toggle-word-${id}`}>
      {` ${word}`}
    </Text>
  );
  const closedLength = cutAt === null ? null : closedCutLength(fullText, cutAt);
  const body = (
    <Text
      style={styles.systemLineText}
      numberOfLines={expanded ? undefined : 2}
      ellipsizeMode="tail"
      testID={`system-line-text-${id}`}
    >
      {overflows && expanded
        ? [...renderSegments(fullText.trimEnd().length), toggleWord('less')]
        : overflows && closedLength !== null
          ? [...renderSegments(closedLength), '…', toggleWord('more')]
          : event
            ? renderSegments()
            : text}
    </Text>
  );
  const hiddenText = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
    'aria-hidden': true,
  } as const;
  return (
    <View style={styles.systemLine} testID={`system-line-${id}`}>
      <View>
        {/* Measure unclamped copy: native reports lines, web reports its laid-out height.
            Android ignores pointerEvents on Text, so the View keeps the copy from taking
            taps where it overflows onto the row below. */}
        <View
          pointerEvents="none"
          style={styles.systemLineMeasurement}
          onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        >
          <Text
            ref={measurementRef}
            testID={`system-line-measurement-${id}`}
            style={styles.systemLineText}
            {...hiddenText}
            onTextLayout={
              Platform.OS === 'web'
                ? undefined
                : ({ nativeEvent }) => {
                    setOverflows(nativeEvent.lines.length > 2);
                  }
            }
            onLayout={Platform.OS === 'web' ? measureWebOverflow : undefined}
          >
            {fullText}
          </Text>
        </View>
        {probeCandidate !== null ? (
          <View pointerEvents="none" style={styles.systemLineMeasurement}>
            <Text
              key={`${probing!.mode}-${probeCandidate}`}
              ref={probeRef}
              testID={`system-line-probe-${id}`}
              style={styles.systemLineText}
              {...hiddenText}
              onTextLayout={
                Platform.OS === 'web'
                  ? undefined
                  : ({ nativeEvent }) => settleProbe(nativeEvent.lines.length <= 2)
              }
            >
              {fullText.slice(0, closedCutLength(fullText, probeCandidate))}…{toggleWord('more')}
            </Text>
          </View>
        ) : null}
        {overflows ? (
          <LedgerDisclosure
            textToggle
            expanded={expanded}
            accessibilityState={{ expanded }}
            accessibilityLabel={
              expanded ? 'Show less of system message' : 'Show full system message'
            }
            onPress={() => setExpanded((value) => !value)}
            rowTestID={`system-line-toggle-${id}`}
          >
            {body}
          </LedgerDisclosure>
        ) : (
          body
        )}
        {callerMessage !== undefined ? (
          <>
            <Text style={styles.systemLineText} testID={`system-line-caller-label-${id}`}>
              Caller's message:
            </Text>
            <Text
              selectable
              dataDetectorType="none"
              style={styles.systemLineText}
              testID={`system-line-caller-message-${id}`}
            >
              {`“${callerMessage}”`}
            </Text>
          </>
        ) : null}
      </View>
      <Text numberOfLines={1} style={styles.roomUpdateStamp} testID={`system-line-stamp-${id}`}>
        {stamp}
      </Text>
    </View>
  );
}


/**
 * The transcript's day caption: sectionHead metrics in the machine face,
 * ledgerQuiet ink, space.md vertical spacing. In-flow on the day-opener
 * cell — never a separate list row, never sticky.
 */
export function LedgerDayCaption({ label }: { label: string }) {
  return (
    <Text testID="ledger-day-caption" style={styles.dayCaption}>
      {label}
    </Text>
  );
}


export function withLedgerDayCaption(node: React.ReactNode, label: string | null): React.ReactNode {
  if (!label) return node;
  const caption = <LedgerDayCaption label={label} />;
  return (
    <View>
      {caption}
      {node}
    </View>
  );
}


/**
 * A wall of tool output, folded into one ghost line.
 *
 * The dimmest tier, one line over a quiet left rule, with its own disclosure —
 * a `git push` rejection dump, a stack trace, an npm error wall never prints
 * down the slab. The label says what happened and the body stays behind a tap
 * (`DESIGN.md`, "Machine noise").
 */
export function LedgerGhostLine({
  label,
  body,
  testID,
}: {
  label: string;
  body: string;
  testID?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <LedgerLogGroup style={styles.ghostBlock} testID={testID}>
      <LedgerDisclosure
        expanded={expanded}
        accessibilityLabel={label}
        accessibilityState={{ expanded }}
        rowTestID={testID ? `${testID}-toggle` : undefined}
        onPress={() => setExpanded((open) => !open)}
      >{label}</LedgerDisclosure>
      {expanded ? (
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          <Text selectable style={styles.ghostBody} testID={testID ? `${testID}-body` : undefined}>
            {body}
          </Text>
        </ScrollView>
      ) : null}
    </LedgerLogGroup>
  );
}


export const BYLINE_DOT_SIZE = 5;


/** Private teaching feedback beneath a locally sent message. */
export function LedgerUntaggedHint({ messageId }: { messageId: string }) {
  return <Text style={styles.untaggedHint} testID={`untagged-message-hint-${messageId}`}>
    No agent was tagged
  </Text>;
}
