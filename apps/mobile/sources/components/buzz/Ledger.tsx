import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useReducedMotion } from 'react-native-reanimated';
import { Typography } from '@/constants/Typography';
import { MonoMarkdown } from './MonoMarkdown';

/**
 * The one transcript primitive a Room and a Corner both render. Prose stays
 * near-white and uses the active theme's prose family; commands and identity
 * stay IBM Plex Mono. A semibold lead sentence, regular body, inter-turn air,
 * and speaker rails carry hierarchy without message cards or dimming content.
 *
 * The surfaces differ in exactly one place, and it tracks a real difference
 * between them. A Corner has one administering agent (`openSubchannel` in
 * `apps/body/src/body.ts` signs every corner with a single identity), named
 * once in the top bar — so a Corner's agent turns carry no handle at all and
 * read as pure flowing text. A Room can hold several agents and several people,
 * so a voice states its handle inline, once, when it takes over. Same
 * component, one prop.
 */

/** The right margin the ghosted stamp hangs in, clear of the flowing column. */
export const LEDGER_MARGINALIA_WIDTH = 36;

type LedgerBodyProps = {
  itemId: string;
  bodyText: string | undefined;
  bodyTestID: string;
  /**
   * The voice's handle, set inline as the first thing on the first line so the
   * entry reads as one log line rather than a name-on-its-own-row header.
   * Omitted on a continuation of the same voice, and omitted entirely in a
   * Corner, whose single agent is named in the top bar.
   */
  handle?: string;
  /** A run's opening entry gets air above it; a continuation keeps flowing. */
  continued?: boolean;
  marginalia?: React.ReactNode;
  replyReference?: React.ReactNode;
  attachments?: React.ReactNode;
  /** The turn's tool run, collapsed — rendered under the prose it belongs to. */
  machineNoise?: React.ReactNode;
  /** A just-committed agent paragraph can reveal locally, even though the
   * relay publishes it atomically. */
  typewriter?: boolean;
};

const TYPEWRITER_TICK_MS = 20;
const TYPEWRITER_CHARS_PER_TICK = 2;

/** The text shown at a typewriter frame. Exported so the reveal contract stays
 * independently testable without pretending relay events arrive as tokens. */
export function typewriterFrame(text: string, visibleCharacters: number): string {
  return text.slice(0, Math.max(0, visibleCharacters));
}

/** Split a turn into its semibold lead sentence and regular body copy. */
export function splitLeadSentence(text: string): [string, string] {
  const normalized = text.trim();
  if (!normalized) return ['', ''];
  if (normalized.startsWith('```')) return ['', normalized];
  const newline = normalized.indexOf('\n');
  const firstLine = newline >= 0 ? normalized.slice(0, newline) : normalized;
  const match = firstLine.match(/^(.+?[.!?](?:["')\]]*)?)(?:\s+|$)(.*)$/);
  if (!match) return [firstLine, newline >= 0 ? normalized.slice(newline + 1).trim() : ''];
  const remainder = [match[2], newline >= 0 ? normalized.slice(newline + 1) : '']
    .filter(Boolean)
    .join('\n')
    .trim();
  return [match[1], remainder];
}

function TypewriterMarkdown({
  markdown,
  textStyle,
  leadingInline,
  testID,
}: {
  markdown: string;
  textStyle: React.ComponentProps<typeof MonoMarkdown>['textStyle'];
  leadingInline?: React.ReactNode;
  testID: string;
}) {
  const reducedMotion = useReducedMotion();
  const [visibleCharacters, setVisibleCharacters] = useState(() =>
    reducedMotion ? markdown.length : 0,
  );

  useEffect(() => {
    if (reducedMotion) {
      setVisibleCharacters(markdown.length);
      return;
    }
    setVisibleCharacters(0);
    const timer = setInterval(() => {
      setVisibleCharacters((current) => {
        const next = Math.min(markdown.length, current + TYPEWRITER_CHARS_PER_TICK);
        if (next === markdown.length) clearInterval(timer);
        return next;
      });
    }, TYPEWRITER_TICK_MS);
    return () => clearInterval(timer);
  }, [markdown, reducedMotion]);

  return (
    <MonoMarkdown
      leadingInline={leadingInline}
      markdown={typewriterFrame(markdown, visibleCharacters)}
      testID={testID}
      textStyle={textStyle}
    />
  );
}

/**
 * The ghosted margin: a fixed-width clock stamp, and (when a voice first
 * announces itself in a Room) the author's short npub under it.
 *
 * Hung in the right margin rather than set into the flow, so the centre stays a
 * clean column — editor line numbers, verse numbers. It is absolutely
 * positioned against the entry so it can never push the prose around, and it
 * takes the dimmest tier because none of it is information the reader is
 * looking for; it is information the reader occasionally checks.
 */
export function LedgerMarginalia({
  stamp,
  detail,
  testID,
}: {
  stamp: string;
  /** A Room appends the author's short npub here; display names are not unique. */
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

/**
 * One turn, written straight onto the slab.
 *
 * `luminous` is the ladder's top step and belongs to the agent alone: its
 * output is the thing the slab exists to show, so it takes the brightest tone
 * and a whisper of bloom. Everyone else writing in the left column takes the
 * ordinary mid-grey. No frame, no rule, no glyph, no box — a run of entries is
 * separated from the next voice by air and nothing else.
 */
export function LedgerEntry({
  itemId,
  bodyText,
  bodyTestID,
  handle,
  continued = false,
  luminous = false,
  marginalia,
  replyReference,
  attachments,
  machineNoise,
  typewriter = false,
}: LedgerBodyProps & { luminous?: boolean }) {
  const [leadText, remainingText] = bodyText && !continued
    ? splitLeadSentence(bodyText)
    : ['', bodyText ?? ''];
  const leadingInline = handle ? (
    <Text style={styles.handle} testID={`chat-handle-${itemId}`}>
      {handle.toUpperCase()}{'  '}
    </Text>
  ) : null;
  return (
    <View
      style={[styles.entry, styles.agentRail, continued ? styles.entryContinued : styles.entryOpens]}
      testID={`chat-message-${itemId}`}
    >
      {marginalia}
      {replyReference}
      {leadText ? (
        <MonoMarkdown
          leadingInline={leadingInline}
          markdown={leadText}
          testID={remainingText ? `${bodyTestID}-lead` : bodyTestID}
          textStyle={styles.ledgerLead}
        />
      ) : null}
      {remainingText ? (
        typewriter ? (
          <TypewriterMarkdown
            leadingInline={leadText ? undefined : leadingInline}
            markdown={remainingText}
            testID={bodyTestID}
            textStyle={luminous ? styles.ledgerTextLuminous : styles.ledgerText}
          />
        ) : (
          <MonoMarkdown
            leadingInline={leadText ? undefined : leadingInline}
            markdown={remainingText}
            testID={bodyTestID}
            textStyle={luminous ? styles.ledgerTextLuminous : styles.ledgerText}
          />
        )
      ) : !leadText && handle ? (
        <Text style={styles.handle} testID={`chat-handle-${itemId}`}>
          {handle.toUpperCase()}
        </Text>
      ) : null}
      {machineNoise}
      {attachments}
    </View>
  );
}

/**
 * You, steering.
 *
 * Identified by geometry alone: pulled to the right margin and one luminance
 * step down from the agent output it interrupts. No caption, no signature, no
 * rule — on a linear log, "the block that is inset and dim is mine" is learned
 * once and never has to be restated. A run of your own messages keeps flowing
 * as one passage for the same reason a voice announces itself once.
 */
export function LedgerSteer({
  itemId,
  bodyText,
  bodyTestID,
  continued = false,
  marginalia,
  replyReference,
  attachments,
}: Omit<LedgerBodyProps, 'handle' | 'machineNoise'>) {
  // `continued` controls only the air between consecutive turns. Applying it
  // to typography made the first short message in a person's run 16px
  // semibold and the next 15px regular, so two otherwise-identical mentions
  // appeared to render differently depending on whether the first one reached
  // an agent. Each human message owns its lead sentence independently.
  const [leadText, remainingText] = bodyText
    ? splitLeadSentence(bodyText)
    : ['', ''];
  return (
    <View
      style={[styles.entry, styles.viewerRail, continued ? styles.entryContinued : styles.entryOpens]}
      testID={`chat-message-${itemId}`}
    >
      {marginalia}
      <View style={styles.steer}>
        {replyReference}
        {leadText ? <MonoMarkdown markdown={leadText} textStyle={styles.steerLead} testID={remainingText ? `${bodyTestID}-lead` : bodyTestID} /> : null}
        {remainingText ? <MonoMarkdown markdown={remainingText} textStyle={styles.steerText} testID={bodyTestID} /> : null}
        {attachments}
      </View>
    </View>
  );
}

/**
 * A wall of tool output, folded into one ghost line.
 *
 * The dimmest tier, one line, with its own disclosure — a `git push` rejection
 * dump, a stack trace, an npm error wall never prints down the slab. The label
 * says what happened and the body stays behind a tap
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
    <View style={styles.ghostBlock} testID={testID}>
      <Pressable
        accessibilityLabel={expanded ? `Collapse ${label}` : `${label}. Expand`}
        accessibilityRole="button"
        onPress={() => setExpanded((open) => !open)}
        style={styles.ghostRow}
      >
        {/* Two Texts, one line. A single truncating Text would eat the
            disclosure copy first — the affordance is the whole point of the
            line, so it is the part that must never be the one to go. Both hold
            plain string children, clear of the Android blank-flex-Text bug. */}
        <Text numberOfLines={1} style={styles.ghostLine}>
          ⋯ {label}
        </Text>
        <Text style={styles.ghostAffordance}> · tap to {expanded ? 'collapse' : 'expand'}</Text>
      </Pressable>
      {expanded ? (
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          <Text selectable style={styles.ghostBody} testID={testID ? `${testID}-body` : undefined}>
            {body}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  entry: {
    width: '100%',
    minWidth: 0,
    paddingRight: LEDGER_MARGINALIA_WIDTH,
    paddingLeft: theme.buzz.railInset,
    paddingVertical: theme.buzz.turnPaddingVertical,
    borderLeftWidth: theme.buzz.railWidth,
  },
  agentRail: { borderLeftColor: theme.buzz.agentRail },
  viewerRail: { borderLeftColor: theme.buzz.humanRail },
  entryContinued: { marginBottom: theme.buzz.continuationGap },
  entryOpens: { marginBottom: theme.buzz.turnGap },
  ledgerLead: {
    fontFamily: theme.buzz.proseSemibold,
    width: '100%',
    minWidth: 0,
    color: theme.buzz.ledgerBright,
    fontSize: theme.buzz.leadSize,
    lineHeight: theme.buzz.leadLineHeight,
  },
  ledgerTextLuminous: {
    fontFamily: theme.buzz.proseRegular,
    width: '100%',
    minWidth: 0,
    color: theme.buzz.ledgerBright,
    fontSize: theme.buzz.proseSize,
    lineHeight: theme.buzz.proseLineHeight,
  },
  ledgerText: {
    fontFamily: theme.buzz.proseRegular,
    width: '100%',
    minWidth: 0,
    color: theme.buzz.ledgerBright,
    fontSize: theme.buzz.proseSize,
    lineHeight: theme.buzz.proseLineHeight,
  },
  handle: {
    fontFamily: theme.buzz.monoSemibold,
    color: theme.buzz.ledgerQuiet,
    fontSize: Math.min(13, theme.buzz.proseSize),
    lineHeight: theme.buzz.proseLineHeight,
    letterSpacing: 0.8,
  },
  marginalia: {
    position: 'absolute',
    top: theme.buzz.turnPaddingVertical + 2,
    right: 0,
    width: LEDGER_MARGINALIA_WIDTH,
    alignItems: 'flex-end',
  },
  marginaliaStamp: {
    ...Typography.mono(),
    color: theme.buzz.ledgerGhost,
    fontSize: 9,
    lineHeight: 12,
  },
  marginaliaDetail: {
    ...Typography.mono(),
    marginTop: 1,
    color: theme.buzz.ledgerGhost,
    fontSize: 8,
    lineHeight: 11,
  },
  steer: { minWidth: 0, width: '100%' },
  steerLead: {
    fontFamily: theme.buzz.proseSemibold,
    minWidth: 0,
    color: theme.buzz.ledgerBright,
    fontSize: theme.buzz.leadSize,
    lineHeight: theme.buzz.leadLineHeight,
  },
  steerText: {
    fontFamily: theme.buzz.proseRegular,
    minWidth: 0,
    color: theme.buzz.ledgerBright,
    fontSize: theme.buzz.proseSize,
    lineHeight: theme.buzz.proseLineHeight,
  },
  ghostBlock: { width: '100%', minWidth: 0, marginTop: 6 },
  ghostRow: { minWidth: 0, flexDirection: 'row', alignItems: 'baseline' },
  ghostLine: {
    ...Typography.mono(),
    flexShrink: 1,
    minWidth: 0,
    color: theme.buzz.ledgerGhost,
    fontSize: 11,
    lineHeight: 20,
  },
  ghostAffordance: {
    ...Typography.mono(),
    flexShrink: 0,
    color: theme.buzz.ledgerGhost,
    fontSize: 11,
    lineHeight: 20,
  },
  ghostBody: {
    ...Typography.mono(),
    marginTop: 4,
    color: theme.buzz.ledgerGhost,
    fontSize: 10,
    lineHeight: 15,
  },
}));
