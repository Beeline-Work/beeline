import { type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { BYLINE_DOT_SIZE } from './Ledger-ledger-steer';
import { LEDGER_MARGINALIA_WIDTH } from './Ledger';

export const styles = StyleSheet.create((theme) => ({
  untaggedHint: {
    ...theme.buzz.type.meta,
    color: theme.buzz.ledgerQuiet,
    marginTop: theme.buzz.space.xs,
    marginLeft: theme.buzz.space.sm,
  },
  entry: {
    width: '100%',
    minWidth: 0,
    paddingTop: theme.buzz.messagePaddingVertical,
    paddingBottom: theme.buzz.messagePaddingVertical,
    marginBottom: theme.buzz.messageGap,
  },
  // Adjacent compact rows contribute 6px each for a 12px same-speaker gap.
  // A bylined row contributes the extra 12px on its visual-top edge, so the
  // preceding row's compact 6px makes the speaker-change boundary 24px
  // whether that preceding row is an agent (always bylined) or a person
  // continuation (no byline). Both lists are upright within a cell: the
  // chronological desktop list is upright, and the inverted phone list flips
  // the whole column and each cell back. A byline's air therefore belongs on
  // `paddingTop` in BOTH — putting it on `paddingBottom` dropped the 24px
  // speaker-change air on the message's visual BOTTOM instead, which is what
  // left a 30px tail under the newest turn and a 12px gap above the next one.
  entryWithByline: {
    paddingTop: theme.buzz.messagePaddingVertical * 3,
  },
  entryWithBylineChronological: {
    paddingTop: theme.buzz.messagePaddingVertical * 3,
  },
  dayCaption: {
    ...theme.buzz.type.sectionHead,
    fontFamily: theme.buzz.type.machine.fontFamily,
    color: theme.buzz.ledgerQuiet,
    marginVertical: theme.buzz.space.md,
  },
  byline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: theme.buzz.space.sm,
  },
  // The words of the byline, on one baseline. `flex: 1` so the stamp's auto
  // margin still has the whole remaining row to push against, `minWidth: 0`
  // so metadata can give way, followed by names that exhaust the row.
  bylineWords: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  bylineDot: {
    width: BYLINE_DOT_SIZE,
    height: BYLINE_DOT_SIZE,
    borderRadius: BYLINE_DOT_SIZE / 2,
    backgroundColor: theme.buzz.agentRail,
  },
  bylineDotViewer: { backgroundColor: theme.buzz.accent },
  // The name reads at body size, medium weight, sentence case — the one line
  // that says who is talking is no longer styled like a timestamp.
  bylineName: {
    fontFamily: theme.buzz.proseMedium,
    color: theme.buzz.ledgerBright,
    fontSize: theme.buzz.proseSize,
    lineHeight: theme.buzz.proseLineHeight,
    flexShrink: 0,
  },
  bylineNameViewer: { color: theme.buzz.accent },
  // The quiet role tag and the clock stamp keep the mono metadata voice.
  bylineTag: {
    ...theme.buzz.type.machine,
    minWidth: 0,
    maxWidth: '44%',
    flexShrink: 1,
    color: theme.buzz.ledgerQuiet,
  },
  bylineStamp: {
    ...theme.buzz.type.machine,
    color: theme.buzz.ledgerQuiet,
    minWidth: 0,
    flexShrink: 1,
  },
  bylineStatus: { marginLeft: 'auto', minWidth: 0, flexShrink: 1, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.xs },
  bookmarkMark: { color: theme.buzz.accent },
  // One face and size throughout the turn; the lead differs only in brightness.
  ledgerLead: {
    fontFamily: theme.buzz.proseRegular,
    width: '100%',
    minWidth: 0,
    color: theme.buzz.ledgerBright,
    fontSize: theme.buzz.proseSize,
    lineHeight: theme.buzz.proseLineHeight,
  },
  /** Hung over the settled words, so the dissolve never moves the column. */
  settleGhost: { position: 'absolute', left: 0, right: 0, top: 0 },
  /**
   * A turn still being written (C98). Same face, size, leading and column as
   * the settled body — the ONLY difference is the quiet tone, so a settling
   * reply changes how the words read without moving them (one family means
   * no wrap point shifts at the settle).
   */
  ledgerProvisional: {
    fontFamily: theme.buzz.proseRegular,
    width: '100%',
    minWidth: 0,
    color: theme.buzz.ledgerQuiet,
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
  roomUpdate: {
    position: 'relative',
    width: '100%',
    minWidth: 0,
    paddingVertical: theme.buzz.space.xs,
    paddingRight: LEDGER_MARGINALIA_WIDTH + 8,
    marginBottom: theme.buzz.space.md,
  },
  roomUpdateLine: {
    ...theme.buzz.type.meta,
    fontFamily: theme.buzz.proseRegular,
    color: theme.buzz.ledgerQuiet,
  },
  roomUpdateLineBrass: { color: theme.buzz.accent },
  // No fixed width: a 36px box clips `17:06` (39px in 13px Plex Mono) to
  // `17:…`. The row's right padding already keeps the clock clear.
  roomUpdateStamp: {
    ...theme.buzz.type.machine,
    position: 'absolute',
    top: theme.buzz.space.xs,
    right: 0,
    color: theme.buzz.ledgerGhost,
    textAlign: 'right',
  },
  historyFailure: { paddingHorizontal: theme.buzz.roomList.edge },
  historyLine: {
    width: '100%',
    paddingVertical: theme.buzz.space.md,
    alignItems: 'center',
  },
  historyLineText: {
    ...theme.buzz.type.meta,
    fontFamily: theme.buzz.proseRegular,
    color: theme.buzz.ledgerQuiet,
    textAlign: 'center',
  },
  systemLine: {
    position: 'relative',
    width: '100%',
    minWidth: 0,
    paddingVertical: theme.buzz.space.xs,
    paddingRight: LEDGER_MARGINALIA_WIDTH + theme.buzz.space.sm,
    marginBottom: theme.buzz.space.md,
  },
  systemLineText: {
    ...theme.buzz.type.meta,
    fontFamily: theme.buzz.proseRegular,
    color: theme.buzz.ledgerQuiet,
  },
  systemLineName: { fontFamily: theme.buzz.proseRegular, color: theme.buzz.accent },
  systemLineLink: {
    fontFamily: theme.buzz.proseRegular,
    color: theme.buzz.ledgerBody,
    textDecorationLine: 'underline',
  },
  roomUpdateDigest: {
    ...theme.buzz.type.meta,
    fontFamily: theme.buzz.proseRegular,
    marginTop: 4,
    marginLeft: theme.buzz.space.md,
    color: theme.buzz.ledgerBody,
  },
  marginalia: {
    position: 'absolute',
    top: theme.buzz.messagePaddingVertical + 2,
    right: 0,
    width: LEDGER_MARGINALIA_WIDTH,
    alignItems: 'flex-end',
  },
  marginaliaStamp: {
    ...theme.buzz.type.machine,
    color: theme.buzz.ledgerGhost,
  },
  marginaliaDetail: {
    ...theme.buzz.type.machine,
    marginTop: theme.buzz.space.xs,
    color: theme.buzz.ledgerGhost,
  },
  // Tool readouts take the quiet left-rule mono treatment — clearly not
  // conversation.
  ghostBlock: {
    width: '100%',
    minWidth: 0,
  },
  ghostBody: {
    ...theme.buzz.type.machine,
    marginTop: 4,
    color: theme.buzz.ledgerGhost,
  },
}));


/**
 * The one provisional tone, shared by the two surfaces that must agree on it:
 * the live draft lane (`components/buzz/StreamingProse.tsx`) writes in it, and
 * the settle cross-fade below fades OUT of it. Read through a function so the
 * theme is resolved at render time, never snapshotted at import.
 */
export function provisionalProseStyle(): TextStyle {
  return styles.ledgerProvisional as TextStyle;
}


/** The settled agent-prose tone shared by final replies and durable narration. */
export function settledAgentProseStyle(): TextStyle {
  return styles.ledgerTextLuminous as TextStyle;
}
