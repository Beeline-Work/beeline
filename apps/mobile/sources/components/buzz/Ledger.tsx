import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useReducedMotion } from 'react-native-reanimated';
import { Typography } from '@/constants/Typography';
import { MonoMarkdown } from './MonoMarkdown';

/**
 * The one transcript primitive a Room and a Corner both render, in the
 * approved Editorial direction: ONE message size everywhere (16/~1.55), Space
 * Grotesk prose with IBM Plex Mono reserved for bylines, code, tool readouts,
 * and system lines. Hierarchy on a long agent turn comes from weight and
 * brightness — a medium-weight bright lead line, then regular secondary
 * prose — never from size. Turns separate by a hairline divider plus generous
 * vertical padding; there are no speaker rails, bubbles, or boxes.
 *
 * Identity lives in the byline above each run's first turn: a small square
 * dot (brass for the viewer, steel for everyone else), then NAME · role ·
 * HH:MM in uppercase mono. A human message is plain body text — regular
 * weight, primary tone, same size as everything — so nothing but the brass
 * byline marks it as the viewer's own.
 *
 * The surfaces differ in exactly one place, and it tracks a real difference
 * between them. A Corner has one administering agent (`openSubchannel` in
 * `apps/body/src/body.ts` signs every corner with a single identity), named
 * once in the top bar — so a Corner's turns carry no byline name at all. A
 * Room can hold several agents and several people, so each voice states its
 * name in its opening byline. Same component, one prop.
 */

/** The right margin the ghosted stamp hangs in, clear of the flowing column. */
export const LEDGER_MARGINALIA_WIDTH = 36;

/** The byline above a run's opening turn. */
export type LedgerByline = {
  /** The voice's display name. Omitted in a Corner (named in the top bar). */
  name?: string;
  /** A quiet role tag, e.g. `agent`. */
  role?: string;
  /** The 24h clock stamp, mono. */
  stamp: string;
  /** True only for the viewer's own turn — switches the dot and name to brass. */
  isViewer?: boolean;
};

type LedgerBodyProps = {
  itemId: string;
  bodyText: string | undefined;
  bodyTestID: string;
  /**
   * The run's opening byline. Omitted on a continuation of the same voice,
   * and the name is omitted entirely in a Corner, whose single agent is named
   * in the top bar.
   */
  byline?: LedgerByline;
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

/** Split a turn into its emphasized lead sentence and regular body copy. */
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
  testID,
}: {
  markdown: string;
  textStyle: React.ComponentProps<typeof MonoMarkdown>['textStyle'];
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
 *
 * The Editorial direction folds the stamp into the byline for prose turns;
 * this gutter survives for the rows that keep the wider margin (the folded
 * tool run), where a stamp without a byline is still worth hanging.
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

function Byline({ byline }: { byline: LedgerByline }) {
  return (
    <View style={styles.byline}>
      <View
        style={[styles.bylineDot, byline.isViewer && styles.bylineDotViewer]}
        testID="chat-byline-dot"
      />
      <Text style={styles.bylineText}>
        {byline.name ? (
          <Text style={[styles.bylineText, byline.isViewer && styles.bylineNameViewer]}>
            {byline.name}
            {' · '}
          </Text>
        ) : null}
        {byline.role ? `${byline.role} · ` : ''}
        {byline.stamp}
      </Text>
    </View>
  );
}

/**
 * One turn, written straight onto the slab in the Editorial direction.
 *
 * An agent turn (`luminous`) may lead with one medium-weight line in the
 * primary tone — hierarchy by weight and brightness at the SAME size — then
 * flows in regular secondary prose. Everyone else writes plain body text at
 * the identical size. Turns separate by a hairline divider; a continuation of
 * the voice directly above keeps flowing with no divider and no byline.
 */
export function LedgerEntry({
  itemId,
  bodyText,
  bodyTestID,
  byline,
  continued = false,
  luminous = false,
  replyReference,
  attachments,
  machineNoise,
  typewriter = false,
}: Omit<LedgerBodyProps, 'marginalia'> & { luminous?: boolean }) {
  const [leadText, remainingText] = bodyText && !continued && luminous
    ? splitLeadSentence(bodyText)
    : ['', bodyText ?? ''];
  const bodyTextStyle = luminous ? styles.ledgerTextLuminous : styles.ledgerText;
  return (
    <View
      style={[
        styles.entry,
        continued ? styles.entryContinued : styles.entryOpens,
      ]}
      testID={`chat-message-${itemId}`}
    >
      {byline ? <Byline byline={byline} /> : null}
      {replyReference}
      {leadText ? (
        <MonoMarkdown
          markdown={leadText}
          testID={remainingText ? `${bodyTestID}-lead` : bodyTestID}
          textStyle={styles.ledgerLead}
        />
      ) : null}
      {remainingText ? (
        typewriter ? (
          <TypewriterMarkdown
            markdown={remainingText}
            testID={bodyTestID}
            textStyle={bodyTextStyle}
          />
        ) : (
          <MonoMarkdown markdown={remainingText} testID={bodyTestID} textStyle={bodyTextStyle} />
        )
      ) : null}
      {machineNoise}
      {attachments}
    </View>
  );
}

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
  continued = false,
  replyReference,
  attachments,
}: Omit<LedgerBodyProps, 'marginalia' | 'machineNoise' | 'typewriter'>) {
  // Deliberately NO lead split here: a human message never takes the
  // emphasized lead treatment. Weight, size, and tone are exactly the agent
  // body's; ownership reads from the byline alone.
  return (
    <View
      style={[styles.entry, continued ? styles.entryContinued : styles.entryOpens]}
      testID={`chat-message-${itemId}`}
    >
      {byline ? <Byline byline={byline} /> : null}
      {replyReference}
      {bodyText ? <MonoMarkdown markdown={bodyText} textStyle={styles.steerText} testID={bodyTestID} /> : null}
      {attachments}
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
    paddingVertical: theme.buzz.turnPaddingVertical,
  },
  // Turn separation: a hairline divider at the top of each opening turn (the
  // inverted list renders a cell's layout-bottom at its visual top), plus the
  // generous vertical padding above. Continuations of the same voice flow on
  // with no divider.
  entryOpens: {
    marginBottom: theme.buzz.turnGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.turnDivider,
  },
  entryContinued: { marginBottom: theme.buzz.continuationGap },
  byline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 9,
  },
  bylineDot: {
    width: 5,
    height: 5,
    borderRadius: 1.5,
    backgroundColor: theme.buzz.agentRail,
  },
  bylineDotViewer: { backgroundColor: theme.buzz.accent },
  bylineText: {
    ...Typography.mono(),
    color: theme.buzz.ledgerQuiet,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  bylineNameViewer: { color: theme.buzz.accent },
  // ONE message size. The lead differs from the body by weight (medium) and
  // brightness (primary), never by size.
  ledgerLead: {
    fontFamily: theme.buzz.proseMedium,
    width: '100%',
    minWidth: 0,
    color: theme.buzz.ledgerBright,
    fontSize: theme.buzz.proseSize,
    lineHeight: theme.buzz.proseLineHeight,
  },
  ledgerTextLuminous: {
    fontFamily: theme.buzz.proseRegular,
    width: '100%',
    minWidth: 0,
    color: theme.buzz.ledgerBody,
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
  // Your own turn: plain body, regular weight, primary tone — never bolded,
  // never enlarged, never inset. The byline carries the ownership signal.
  steerText: {
    fontFamily: theme.buzz.proseRegular,
    minWidth: 0,
    width: '100%',
    color: theme.buzz.ledgerBright,
    fontSize: theme.buzz.proseSize,
    lineHeight: theme.buzz.proseLineHeight,
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
  // Tool readouts take the quiet left-rule mono treatment — clearly not
  // conversation.
  ghostBlock: {
    width: '100%',
    minWidth: 0,
    marginTop: 6,
    borderLeftWidth: 2,
    borderLeftColor: theme.buzz.agentRail,
    paddingLeft: 13,
  },
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
