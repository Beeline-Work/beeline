import { ErrorBanner } from './ErrorBanner';
import { LedgerDisclosure, LedgerLogGroup } from './LedgerDisclosure';
import { webhookCallerMessage } from '@/buzz/system-lines';
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { MonoMarkdown } from './MonoMarkdown';
import type { SystemEvent, SystemSubject } from '@beeline/api-contract/phone';
import { LedgerBodyProps, ledgerEntryRhythm, Byline } from './Ledger';
import { styles } from './Ledger-styles';

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
        style={
          tone === 'brass'
            ? [styles.roomUpdateLine, styles.roomUpdateLineBrass]
            : styles.roomUpdateLine
        }
        testID={`room-update-line-${id}`}
      >
        {line}
      </Text>
      <Text style={styles.roomUpdateStamp} testID={`room-update-stamp-${id}`}>
        {stamp}
      </Text>
      {digest ? (
        <Text style={styles.roomUpdateDigest} testID={`room-update-digest-${id}`}>
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
  return (
    <View style={styles.systemLine} testID={`system-line-${id}`}>
      <View>
        <Text style={styles.systemLineText} testID={`system-line-text-${id}`}>
          {segments.map(segment => segment.render ? segment.render(segment.text) : segment.text)}
        </Text>
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
      <Text style={styles.roomUpdateStamp} testID={`system-line-stamp-${id}`}>
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
