import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatSource = readFileSync(
  new URL('../../app/(app)/buzz/chat/[channelId].tsx', import.meta.url),
  'utf8',
);
const ledgerSource = readFileSync(new URL('./Ledger.tsx', import.meta.url), 'utf8');
const markdownSource = readFileSync(new URL('./MonoMarkdown.tsx', import.meta.url), 'utf8');
const activitySource = readFileSync(new URL('./ActivityTimeline.tsx', import.meta.url), 'utf8');
const emptyLedgerSource = readFileSync(new URL('./EmptyLedgerState.tsx', import.meta.url), 'utf8');
// Enter-room hydration lives here, not inline in the screen: every read is
// fanned out concurrently so none can be held hostage by another.
const roomEntrySource = readFileSync(new URL('../../buzz/room-entry.ts', import.meta.url), 'utf8');
const agentPresenceSource = readFileSync(
  new URL('../../buzz/agent-presence.ts', import.meta.url),
  'utf8',
);

function styleDefinition(source: string, name: string): string {
  const start = source.indexOf(`  ${name}: {`);
  expect(start, `missing style definition for ${name}`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed style definition for ${name}`);
}

/** The one render path both surfaces take, from identity resolution to return. */
function ledgerBranch(): string {
  const start = chatSource.indexOf('      // ── The ledger (§ DESIGN.md "The ledger") ──');
  expect(start, 'missing the shared ledger branch of renderItem').toBeGreaterThanOrEqual(0);
  const end = chatSource.indexOf('    [\n      agentByPubkey,', start);
  expect(end, 'ledger branch is not followed by the renderItem dep list').toBeGreaterThan(start);
  return chatSource.slice(start, end);
}

describe('Empty ledger contract', () => {
  it('centers the empty state in a non-inverted flex-growing transcript viewport', () => {
    expect(chatSource).toContain('inverted={invertedMessages.length > 0}');
    expect(chatSource).toContain('invertedMessages.length === 0 && styles.messageListContentEmpty');
    expect(styleDefinition(chatSource, 'messageListContentEmpty')).toContain('flexGrow: 1');
    expect(styleDefinition(chatSource, 'emptyState')).toContain('flexGrow: 1');
    expect(styleDefinition(chatSource, 'emptyState')).not.toContain('paddingTop');
  });

  it('uses one operational Room, Corner, and DM state that focuses the composer', () => {
    expect(chatSource).toContain('<EmptyLedgerState');
    expect(chatSource).toContain('variant={emptyLedgerVariant}');
    expect(chatSource).toContain('objective={isCorner ? cornerObjective : undefined}');
    expect(chatSource).toContain('onPress={focusComposer}');
    expect(chatSource).toMatch(
      /const focusComposer = useCallback\([\s\S]{0,120}composerRef\.current\?\.focus/,
    );
    expect(chatSource).not.toContain('No messages yet');

    expect(emptyLedgerSource).toContain(
      "export type EmptyLedgerVariant = 'room' | 'corner' | 'dm'",
    );
    expect(emptyLedgerSource).toContain(
      'Start with the work, question, or decision this Room is for.',
    );
    expect(emptyLedgerSource).toContain('Ready for a steering message');
    expect(emptyLedgerSource).toContain('Send ${person} the first message.');
    expect(styleDefinition(emptyLedgerSource, 'title')).toMatch(/fontSize:\s*16/);
    expect(emptyLedgerSource).not.toMatch(/borderRadius|backgroundColor/);
  });
});

describe('One ledger, both surfaces', () => {
  it('renders Rooms and Corners through the same shared primitive', () => {
    // Not "a Room component and a Corner component that look alike" — literally
    // one branch, one set of components, for both.
    expect(chatSource).toMatch(
      /import \{[\s\S]{0,200}LedgerEntry,[\s\S]{0,200}\} from '@\/components\/buzz\/Ledger'/,
    );
    expect(chatSource.match(/<LedgerEntry\b/g)?.length).toBe(1);
    expect(chatSource.match(/<LedgerSteer\b/g)?.length).toBe(1);

    // No second transcript implementation survives anywhere.
    expect(chatSource).not.toMatch(/<TranscriptRow\b/);
    expect(chatSource).not.toMatch(/<CornerLedgerEntry\b/);
    expect(chatSource).not.toMatch(/<CornerSteer\b/);
    for (const retired of [
      'messageBubble',
      'otherBubble',
      'ownBubble',
      'roomMessageRow',
      'authorRow',
      'roleLabel',
      'messageText',
      'terminalTurn',
      'terminalTurnUser',
      'terminalTurnText',
      'terminalAgentTurn',
    ]) {
      expect(chatSource, `${retired} should be retired`).not.toMatch(
        new RegExp(`\\b${retired}:\\s*\\{`),
      );
    }
  });

  it('gives no transcript message a box on either surface', () => {
    for (const name of ['entry', 'byline', 'marginalia', 'ghostBlock']) {
      const definition = styleDefinition(ledgerSource, name);
      expect(definition, `${name} must stay boxless`).not.toMatch(/borderRadius/);
      expect(definition, `${name} must stay boxless`).not.toMatch(/backgroundColor/);
      // A quiet left rule is the Editorial readout vocabulary; a full frame is
      // never allowed.
      expect(definition, `${name} must stay boxless`).not.toMatch(/border(?:Top|Right)Width/);
      if (name !== 'ghostBlock') {
        expect(definition, `${name} must stay boxless`).not.toMatch(
          /border(?:Top|Bottom|Left)(?:Width|Color)/,
        );
      }
    }
    // ...and the activity group the same, on both surfaces.
    const group = styleDefinition(chatSource, 'activityGroup');
    expect(group).not.toMatch(/border/);
    expect(group).not.toMatch(/backgroundColor/);
  });

  it('separates turns with a tokenized hairline divider, not rails or bubbles', () => {
    // The Editorial direction removed the left author rails entirely; the
    // only edges left in the ledger are the opening-turn divider and the
    // machine-noise readout rule.
    const entry = styleDefinition(ledgerSource, 'entry');
    expect(entry).toMatch(/paddingVertical:\s*theme\.buzz\.turnPaddingVertical/);
    const opens = styleDefinition(ledgerSource, 'entryOpens');
    const continued = styleDefinition(ledgerSource, 'entryContinued');
    expect(opens).toMatch(/borderBottomWidth:\s*StyleSheet\.hairlineWidth/);
    expect(opens).toMatch(/borderBottomColor:\s*theme\.buzz\.turnDivider/);
    expect(opens).toMatch(/theme\.buzz\.turnGap/);
    expect(continued).toMatch(/theme\.buzz\.continuationGap/);
    expect(continued).not.toMatch(/borderBottomWidth/);
    // No speaker rail survives anywhere in the file.
    expect(ledgerSource).not.toMatch(/styles\.agentRail|styles\.viewerRail/);
    expect(ledgerSource).not.toMatch(/steerRule/);

    // A system row in the flow is separated the same way — never framed off.
    for (const [source, name] of [
      [ledgerSource, 'roomUpdate'],
      [chatSource, 'replyReference'],
    ] as const) {
      expect(styleDefinition(source, name), `${name} must not draw an edge`).not.toMatch(
        /border(?:Top|Bottom|Left|Right)?(?:Width|Color)/,
      );
    }
  });

  it('marks the viewer with the brass byline alone and no caption', () => {
    // Brass #b08a4a is the single accent, and ownership reads ONLY from the
    // byline dot and name — never from weight, size, or geometry.
    expect(styleDefinition(ledgerSource, 'bylineDotViewer')).toMatch(
      /backgroundColor:\s*theme\.buzz\.accent/,
    );
    expect(styleDefinition(ledgerSource, 'bylineNameViewer')).toMatch(
      /color:\s*theme\.buzz\.accent/,
    );
    expect(styleDefinition(ledgerSource, 'bylineDot')).toMatch(
      /backgroundColor:\s*theme\.buzz\.agentRail/,
    );
    // The "YOU" caption and its signature are gone from the ledger entirely.
    expect(ledgerSource).not.toMatch(/steerSignature/);
    expect(chatSource).not.toMatch(/steerSignature/);
    expect(chatSource).not.toMatch(/'YOU'/);
  });

  it('carries hierarchy by weight and brightness at ONE size, never size', () => {
    const luminous = styleDefinition(ledgerSource, 'ledgerTextLuminous');
    expect(luminous).toMatch(/fontFamily:\s*theme\.buzz\.proseRegular/);
    // An agent's flowing prose sits one brightness step DOWN from its lead.
    expect(luminous).toMatch(/color:\s*theme\.buzz\.ledgerBody/);
    const lead = styleDefinition(ledgerSource, 'ledgerLead');
    expect(lead).toMatch(/fontFamily:\s*theme\.buzz\.proseMedium/);
    expect(lead).toMatch(/color:\s*theme\.buzz\.ledgerBright/);
    // ONE size: lead and every body share the exact same tokens.
    for (const name of ['ledgerLead', 'ledgerTextLuminous', 'ledgerText', 'steerText']) {
      const definition = styleDefinition(ledgerSource, name);
      expect(definition).toMatch(/fontSize:\s*theme\.buzz\.proseSize/);
      expect(definition).toMatch(/lineHeight:\s*theme\.buzz\.proseLineHeight/);
    }
    // Your own message is plain body: regular face, primary tone — never the
    // emphasized lead family, never enlarged (captain correction of the
    // auto-bold mockup).
    const steer = styleDefinition(ledgerSource, 'steerText');
    expect(steer).toMatch(/fontFamily:\s*theme\.buzz\.proseRegular/);
    expect(steer).toMatch(/color:\s*theme\.buzz\.ledgerBright/);
    expect(styleDefinition(ledgerSource, 'bylineText')).toMatch(/Typography\.mono\(/);
    expect(styleDefinition(markdownSource, 'bold')).toMatch(
      /fontFamily:\s*theme\.buzz\.proseSemibold/,
    );
    expect(ledgerSource).toContain('splitLeadSentence(bodyText)');
    expect(ledgerSource).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    // And the lead split belongs to agent turns alone: a steer never takes it.
    expect(ledgerSource.slice(ledgerSource.indexOf('export function LedgerSteer'))).not.toContain(
      'splitLeadSentence',
    );
  });

  it('keeps ordinary metadata in the gutter and centers machine timestamps in their row', () => {
    const marginalia = styleDefinition(ledgerSource, 'marginalia');
    expect(marginalia).toMatch(/position:\s*'absolute'/);
    expect(marginalia).toMatch(/right:\s*0/);
    expect(marginalia).toMatch(/width:\s*LEDGER_MARGINALIA_WIDTH/);
    // The compact machine row owns its timestamp so it shares the labels'
    // baseline; it no longer reserves a second-row marginalia gutter.
    expect(styleDefinition(chatSource, 'activityGroup')).not.toMatch(
      /paddingRight:\s*LEDGER_MARGINALIA_WIDTH/,
    );
    expect(styleDefinition(activitySource, 'liveStamp')).toMatch(/fontSize:\s*10/);
    for (const name of ['marginaliaStamp', 'marginaliaDetail']) {
      expect(styleDefinition(ledgerSource, name)).toMatch(/color:\s*theme\.buzz\.ledgerGhost/);
    }
  });
});

describe('The obsidian slab', () => {
  /**
   * Everything that renders inside the transcript flow. None of these is a
   * "genuinely distinct, non-repeating region" — they are content, so none may
   * take a bordered, filled, rounded container (DESIGN.md, "Shape").
   */
  const TRANSCRIPT_FLOW_STYLES = [
    'activityGroup',
    'archivedBubble',
    'attachmentCard',
    'attachmentFileGlyph',
    'replyReference',
  ];

  it('lets no transcript content sit in a box', () => {
    for (const name of TRANSCRIPT_FLOW_STYLES) {
      const block = styleDefinition(chatSource, name);
      expect(block, `${name} must not be a bordered container`).not.toMatch(/borderWidth/);
      expect(block, `${name} must not have a radius`).not.toMatch(/borderRadius/);
      expect(block, `${name} must not fill its own surface`).not.toMatch(/backgroundColor/);
    }
    const update = styleDefinition(ledgerSource, 'roomUpdate');
    expect(update).not.toMatch(/borderWidth|borderRadius|backgroundColor/);
  });

  it('leaves no bordered status banner anywhere in the transcript flow', () => {
    // A status is not something the reader must find and act on, so it never
    // earns a box. The write-permission outcome was the last one left — a
    // bordered, filled chip that read as a plate laid on the slab.
    const outcomeSource = readFileSync(
      new URL('./WritePermissionOutcome.tsx', import.meta.url),
      'utf8',
    );
    expect(outcomeSource).not.toMatch(/border(?:Top|Bottom|Left|Right)?(?:Width|Color|Radius)/);
    expect(outcomeSource).not.toMatch(/backgroundColor/);
    expect(outcomeSource).not.toMatch(/cornerOpenChip/);
    expect(outcomeSource).not.toMatch(/minHeight/);

    // One dim inscribed line at the prose margin.
    expect(styleDefinition(outcomeSource, 'outcome')).toMatch(
      /paddingRight:\s*LEDGER_MARGINALIA_WIDTH/,
    );
    expect(styleDefinition(outcomeSource, 'status')).toMatch(/color:\s*groknight\.ledgerQuiet/);
    // It reports a decision and never navigates: an open corner is live state,
    // and live state is the pinned bar's job, not a scroll note's.
    expect(outcomeSource).not.toContain('CORNER OPEN');
    expect(outcomeSource).not.toContain('view →');
    expect(outcomeSource).not.toMatch(/Pressable|onOpenCorner/);
    // Faceted diamond for corner, so the lifecycle glyph family still holds.
    expect(outcomeSource).toContain('◇ ALLOWED');

    // ...and the one row that *does* still navigate carries the same
    // vocabulary: the pinned corner line, which is no longer in the scroll.
    const barSource = readFileSync(new URL('./CornerLiveBar.tsx', import.meta.url), 'utf8');
    expect(barSource).toContain('view →');
    expect(chatSource).not.toMatch(/openCornerGlyph|styles\.openCornerText/);
  });

  it('separates a system row with air, not with an edge', () => {
    // A Room update is the ledger's remaining interruption: air, no edge.
    const update = styleDefinition(ledgerSource, 'roomUpdate');
    expect(update).not.toMatch(/border/);
    expect(Number(update.match(/marginBottom:\s*(\d+)/)![1])).toBeGreaterThan(0);
  });

  it('gives the transcript chrome no surface of its own', () => {
    // A textured HullSurface header read as a plate laid over the slab. The
    // sheets and the merge-approval panel still earn one; the header does not.
    expect(chatSource).not.toMatch(
      /<HullSurface\s*\n?\s*strength="quiet"\s*\n?\s*style=\{\[styles\.header/,
    );
    expect(styleDefinition(chatSource, 'header')).toMatch(/hairlineDivider|borderBottom/);
  });

  it('marks a fenced code block with a steel rule, not a panel', () => {
    const markdownSource = readFileSync(new URL('./MonoMarkdown.tsx', import.meta.url), 'utf8');
    const frame = styleDefinition(markdownSource, 'codeFrame');
    expect(frame).not.toMatch(/backgroundColor/);
    expect(frame).not.toMatch(/borderRadius/);
    // The Editorial readout vocabulary: a 2px left rule in the theme's peak
    // steel, shared with tool output.
    expect(frame).toMatch(/borderLeftWidth:\s*2/);
    expect(frame).toMatch(/borderLeftColor:\s*theme\.buzz\.bgTexturePeak/);
  });
});

describe('Speaker identity', () => {
  it('opens a Room run with one byline, above the words', () => {
    const branch = ledgerBranch();
    // One expression decides it for every shape, so prose, telemetry, and a
    // person's entry can never disagree about who is speaking.
    expect(branch).toMatch(/const byline: LedgerByline \| undefined = attributionContinued/);
    expect(branch).toMatch(/<LedgerEntry[\s\S]{0,200}byline=\{byline\}/);
    expect(branch).toMatch(/<LedgerSteer[\s\S]{0,200}byline=\{byline\}/);
    // The ledger renders it as a header row, never inline with the words.
    expect(ledgerSource).toContain('<Byline byline={byline} />');
  });

  it('attributes a Corner exactly like a Room — mark + name/You, per run', () => {
    const branch = ledgerBranch();
    // Owner override (2026-08): corners hold several participants, so bare
    // turns are indistinguishable there. The old zero-byline rule —
    // `name: isCorner ? undefined : …` and the structural `isCornerAgent`
    // assumption that mislabeled other people as the agent — is deleted; the
    // shared projection helper (`buzz/ledger-attribution.ts`) decides voices
    // for both surfaces.
    expect(branch).not.toMatch(/name: isCorner \? undefined/);
    expect(branch).not.toContain('const isCornerAgent');
    expect(branch).toContain("name: isSelfSteer ? 'You' : voiceName");
    expect(branch).toContain("role: speaksAsAgent ? 'agent' : undefined");
    // The corner header still names its administering agent in the top bar.
    expect(chatSource).toMatch(
      /isCorner && cornerAgentPubkey && \([\s\S]{0,400}testID="corner-header-agent"[\s\S]{0,400}<IdentityMark/,
    );
    expect(chatSource).toContain('styles.cornerHeaderAgent');
  });

  it('repeats no byline for a continued run, on either surface', () => {
    expect(ledgerBranch()).toContain(
      'const byline: LedgerByline | undefined = attributionContinued',
    );
    expect(ledgerBranch()).toMatch(/attributionContinued\s*\n\s*\? undefined/);
  });

  it('never spends the prose byline on a collapsed tool/thought block', () => {
    // Owner report (peddle room, 2026-08-23): in [tool-summary, prose] runs
    // the byline was consumed by the tool block and the agent's text turn
    // rendered bare. The screen must tell the shared attribution helper which
    // rows are machine noise, so prose re-announces across them.
    expect(chatSource).toContain('continuedSpeakerIds');
    expect(chatSource).toMatch(/isMachine:\s*message\.isAgentActivity/);
  });

  it('leads every byline with the speaker’s EXISTING identity mark, not a new one', () => {
    const branch = ledgerBranch();
    // The mark is keyed on the message signer's pubkey — the same seed every
    // other surface renders — and its kind follows the same speaksAsAgent
    // decision the entry/steer split already uses. No second mark vocabulary.
    expect(branch).toContain(
      "item.pubkey ?? (isSelfSteer ? cacheViewerPubkey || 'self' : 'unknown-person')",
    );
    expect(branch).toContain("kind: speaksAsAgent ? 'agent' : 'human'");
    // An agent carries the gold ring only while its presence lease says alive;
    // the verdict comes from `onlineVerdicts`, whose only liveness helper is
    // the SAME `isAgentPresenceOnlineWithReconnectGrace` every other
    // online/offline decision on this screen uses. The flat boolean record is
    // what lets renderItem stay identity-stable across heartbeats instead of
    // rebuilding every visible ledger row per tick.
    expect(branch).toMatch(
      /speakerAlive =\n\s*speaksAsAgent && Boolean\(item\.pubkey\) && Boolean\(speakerOnline\[item\.pubkey \?\? ''\]\)/,
    );
    expect(chatSource).toContain('onlineVerdicts(agentPresences');
    expect(agentPresenceSource).toMatch(
      /export function onlineVerdicts[\s\S]{0,600}isAgentPresenceOnlineWithReconnectGrace/,
    );
    // And the ledger renders it through the one identity-mark component.
    expect(ledgerSource).toContain("import { IdentityMark } from './IdentityMark'");
    expect(ledgerSource).toContain('testID="chat-byline-mark"');
  });

  it('reads the agent roster the Members screen reads, so both name an agent the same', () => {
    // Every agent name in the transcript comes from `listAgents`, which is what
    // hydrates the human-authored soul overlay. Scoping that read strictly to
    // the channel's own community left a Room that resolves none with no roster
    // at all, so the transcript showed the seed placeholder while Members
    // showed the real soul name for the same key.
    expect(roomEntrySource).toMatch(
      /agentRosterCommunityIds\(\s*\n?\s*channelCommunityId,\s*\n?\s*activeCommunityId,\s*\n?\s*communities\.map/,
    );
    expect(roomEntrySource).toMatch(/gapFillers\.map\(readAgents\)/);
    expect(roomEntrySource).toContain('mergeAgentRosters([primary, ...rosters]).values()');
    // One unreachable Workspace must not cost the others their names...
    expect(roomEntrySource).toMatch(/client\.listAgents\(communityId\)\.catch\(/);
    // ...and the roster commits as soon as it resolves, so an unrelated failure
    // later in the init chain cannot leave the transcript with no names at all:
    // agents are their own handler, never behind the person-profile read.
    expect(roomEntrySource).toMatch(/live\(\(\) => handlers\.onAgents\?\.\(primary\)\)/);
    expect(roomEntrySource).toMatch(/live\(\(\) => handlers\.onAgents\?\.\(merged\)\)/);
    expect(chatSource).toMatch(
      /onAgents: \(agents\) => \{\s*\n\s*rememberKnownAgents\(agents\);\s*\n\s*patchChannelCache\(identity\.publicKey, \{ availableAgents: agents \}\);\s*\n\s*\}/,
    );
    // One identity everywhere: the transcript folds the device-wide agent-name
    // cache under its own roster, so a Room whose own read is stale or absent
    // still renders the name the agent was given in any other Workspace.
    expect(chatSource).toContain(
      'withKnownAgentNames(knownAgentNames, channelCache?.availableAgents ?? [])',
    );

    // ...and only the roster widens. Membership, roles, and profile writes are
    // authority-adjacent and stay on the channel's own community.
    expect(roomEntrySource).toContain('client.communityMembers(communityId)');
    expect(roomEntrySource).toMatch(
      /const roster = workspaceRead\.then\(async \(communityId\) => \{/,
    );
    expect(roomEntrySource).not.toMatch(/communityMembers\(gapFiller/);
    expect(roomEntrySource).not.toMatch(/listPersonProfiles\(\s*\n?\s*gapFiller/);
    expect(chatSource).not.toMatch(/replaceProfiles\([^)]*rosterCommunityId/);
    expect(chatSource).not.toMatch(
      /saveActiveCommunityId\(identity\.publicKey, rosterCommunityId\)/,
    );

    // The one resolver, everywhere the transcript names an agent — gated on
    // `participantsHydrated` so a pending roster read shows a neutral
    // placeholder instead of the seed fallback (`resolveAgentDisplayIdentity`'s
    // own placeholder) for a beat before snapping to the real name.
    expect(chatSource).not.toMatch(/fallbackAgentName\(/);
    for (const [label, site] of [
      [
        'corner header',
        /resolvePendingAgentDisplay\(\s*cornerAgentPubkey,\s*agentByPubkey\.get\(cornerAgentPubkey\),\s*participantsHydrated,?\s*\)/,
      ],
      [
        'transcript turn',
        /resolvePendingAgentDisplay\(\s*item\.pubkey \?\? 'unknown-agent',\s*knownAgent,\s*participantsHydrated,?\s*\)/,
      ],
    ]) {
      expect(chatSource, `${label} must resolve through the roster`).toMatch(site);
    }
  });

  it('marks your own turn by its brass byline, never by a caption or emphasis', () => {
    const branch = ledgerBranch();
    expect(branch).toContain('const isSelfSteer = isOwn && !isAgent');
    expect(branch).toMatch(/isSelfSteer \? \(\s*\n\s*<LedgerSteer/);
    expect(branch).not.toMatch(/'YOU' \?/);
    expect(branch).toMatch(/isViewer: isSelfSteer/);
    expect(branch).not.toMatch(/signature=/);
  });
});

describe('Machine noise', () => {
  it('renders one shared tool ledger on both surfaces', () => {
    // The `parentChannelId` gate is gone: a Room collapses telemetry the same
    // way a Corner does, rather than showing it raw or hiding it entirely.
    expect(chatSource).not.toMatch(/item\.isAgentActivity && parentChannelId/);
    expect(chatSource).toMatch(/if \(item\.isAgentActivity\) \{/);

    const start = chatSource.indexOf('function LedgerActivity(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = chatSource.indexOf('function AgentPresenceLight(');
    const activity = chatSource.slice(start, end);
    expect(activity).toContain('<ActivityTimeline');
    expect(activity).not.toContain('turn.updates');
    expect(activitySource).not.toContain('turn.updates');
    expect(chatSource).not.toMatch(/\bactivityUpdate:\s*\{/);
  });

  it('uses live-only one-line hairline rows with no replay affordance', () => {
    expect(activitySource).not.toContain('GROUP_THRESHOLD');
    expect(activitySource).toContain(
      'if (!active || (!thought && !messageDraft && !steps.length))',
    );
    expect(activitySource).not.toContain('activity-step-group');
    expect(activitySource).not.toContain('<Pressable');
    expect(styleDefinition(activitySource, 'stepRow')).toMatch(/minHeight:\s*36/);
    expect(styleDefinition(activitySource, 'stepRow')).toMatch(
      /borderTopWidth:\s*StyleSheet\.hairlineWidth/,
    );
    expect(styleDefinition(activitySource, 'stepLabel')).toMatch(/Typography\.mono\(\)/);
    expect(activitySource).not.toContain('FAILED');
    expect(activitySource).not.toContain('BlurView');
    expect(activitySource).not.toContain('HullActionSheet');
  });

  it('puts attribution and timestamp on the live turn without an indent gutter', () => {
    expect(activitySource).toContain('handle.toUpperCase()');
    expect(styleDefinition(activitySource, 'liveByline')).toMatch(/flexDirection:\s*'row'/);
    expect(styleDefinition(activitySource, 'liveStamp')).toMatch(/marginLeft:\s*'auto'/);
    expect(chatSource).toContain('stamp={ledgerStamp(item.timestamp)}');
    expect(chatSource).not.toContain('testID={`chat-marginalia-${item.id}`}');
  });

  it('keeps the accumulating agent message out of the tool ledger entirely', () => {
    const narration = styleDefinition(activitySource, 'messageDraft');
    expect(narration).toMatch(/Typography\.ledger\(\)/);
    expect(narration).toMatch(/color:\s*groknight\.ledgerBright/);
    // ONE message size (Editorial direction): narration is message text, so
    // it matches the ledger body exactly.
    expect(narration).toMatch(/fontSize:\s*16/);
    expect(narration).not.toMatch(/textShadow/);
    expect(narration).not.toMatch(/paddingLeft/);
    expect(activitySource).toContain('testID="activity-message-draft"');
    // Machine steps stay quiet and mono; brass is reserved for the failure mark.
    expect(styleDefinition(activitySource, 'stepLabel')).toMatch(/color:\s*groknight\.ledgerQuiet/);
    expect(styleDefinition(activitySource, 'verdictFailed')).toMatch(/color:\s*groknight\.accent/);
    expect(styleDefinition(activitySource, 'stepReason')).not.toMatch(/groknight\.accent/);
  });

  it('matches the thinking transcript to the prose voice, one step down and upright', () => {
    const thought = styleDefinition(activitySource, 'thoughtText');
    // Same type family as surrounding prose (theme prose face — Space Grotesk
    // in Obsidian), never a second voice or a hardcoded face.
    expect(thought).toMatch(/fontFamily:\s*groknight\.proseRegular/);
    expect(thought).not.toMatch(/Typography\.default|IBMPlexSans/);
    expect(thought).not.toMatch(/^\s*fontStyle:/m);
    // One existing step below the ONE message size (16): the same register
    // RoomContextPreamble's ghost lines use.
    expect(thought).toMatch(/fontSize:\s*14/);
    expect(thought).toMatch(/lineHeight:\s*22/);
    // The dimmer text token for redundant machine noise.
    expect(thought).toMatch(/color:\s*groknight\.ledgerQuiet/);
    // Rail geometry is unchanged: the quiet 2px left rule stays.
    const lane = styleDefinition(activitySource, 'thoughtLane');
    expect(lane).toMatch(/borderLeftWidth:\s*2/);
    expect(lane).toMatch(/borderLeftColor:\s*groknight\.borderQuiet/);
  });

  it('pins the corner indicator above the composer instead of inscribing it', () => {
    const barSource = readFileSync(new URL('./CornerLiveBar.tsx', import.meta.url), 'utf8');
    // Gold, and gold only — this is the accent's own assigned meaning
    // (DESIGN.md: live/online presence), never a second hue.
    expect(styleDefinition(barSource, 'labelLive')).toMatch(/color:\s*groknight\.accent/);
    expect(barSource).not.toMatch(/#[0-9a-fA-F]{3,8}(?!\d)/);
    // A status light needs no frame: it is always in the same place.
    expect(styleDefinition(barSource, 'bar')).not.toMatch(/border|borderRadius/);
    // One line that breathes — never a band of dashes, a sweep, or a bar that
    // fills. It reuses the shared live clock, so it settles under reduced
    // motion and in the background without owning that logic itself.
    expect(barSource).toContain('<HullLivePulse>{row}</HullLivePulse>');
    expect(barSource).not.toMatch(/segment|FlowSegment|withRepeat|translateX/);

    // ...and every LIVE corner note it replaced is gone from the transcript
    // scroll. The archived replacement is intentionally retained below as a
    // structural Room update.
    expect(chatSource).toMatch(/if \(item\.corner\) \{\s*return null;\s*\}/);
    expect(chatSource).toMatch(
      /if \(permission\.status === 'allowed' && permission\.subchannelId\) return null;/,
    );
    expect(chatSource).not.toMatch(/testID="agent-live-status"/);
    expect(chatSource).not.toMatch(/testID=\{`corner-status-\$\{item\.corner\.status\}`\}/);
  });

  it('stamps no live corner status into the transcript', () => {
    // "Alden ✕ FAILED" and "◇ OPEN" rows interrupted a live conversation with
    // a dead record, and duplicated the pinned indicator while they were at
    // it. A corner's status is state: it belongs to the pinned line above the
    // composer while it is active, and to the Room's corners view once it is
    // not. Terminal history is derived from canonical state as a Room update.
    const branch = chatSource.slice(
      chatSource.indexOf('      if (item.corner) {'),
      chatSource.indexOf(
        '      // ── Archived notice',
        chatSource.indexOf('      if (item.corner) {'),
      ),
    );
    expect(branch).toContain('return null');
    expect(branch).not.toMatch(/cornerStatusPresentation|presentation\.(?:glyph|label)/);
    expect(branch).not.toContain('archived-corner-summary');
    // ...and the styles that drew it are gone with it, not left behind dead.
    for (const name of ['cornerStatusCard', 'cornerStatusLabel', 'cornerPresenceDot']) {
      expect(chatSource, `${name} should have been removed`).not.toContain(`  ${name}: {`);
    }
  });

  it('gives each ledger one outcome-specific composer and one overflow menu', () => {
    // One shared composer, with surface-specific operational copy rather than
    // a generic consumer-chat placeholder.
    expect(chatSource).toContain('placeholder={composerPlaceholder}');
    expect(chatSource).toContain('`Start this ${ROOM_LABEL}…`');
    expect(chatSource).toContain('`Steer this ${CORNER_LABEL}…`');
    expect(chatSource).toContain('`Message ${displayRoomName}…`');
    expect(chatSource).not.toContain('placeholder="Message"');
    for (const retired of ['cornerComposer', 'cornerInput', 'cornerSendButtonText']) {
      expect(chatSource, `${retired} should be retired`).not.toMatch(
        new RegExp(`\\b${retired}\\b`),
      );
    }
    // Close corner moved off the composer and into the header overflow, which
    // is the same ••• affordance the Room header already carries.
    expect(chatSource).not.toMatch(/cancelTurn/);
    expect(chatSource).toMatch(/testID="corner-actions-menu"/);
    expect(chatSource).toMatch(/testID="close-corner-action"/);
    // ...and the only place the close copy survives is inside that sheet.
    expect(chatSource.match(/CLOSE \{CORNER_LABEL/g)).toHaveLength(1);
    expect(chatSource.indexOf('CLOSE {CORNER_LABEL')).toBeGreaterThan(
      chatSource.indexOf('testID="close-corner-action"'),
    );
    const menu = chatSource.indexOf('testID="corner-actions-menu"');
    const list = chatSource.indexOf('testID="chat-messages"');
    expect(menu).toBeGreaterThanOrEqual(0);
    expect(menu).toBeLessThan(list);
  });

  it('lifts a pasted git/CLI wall out of an agent’s prose into the same ghost line', () => {
    const branch = ledgerBranch();
    // Gated on `!isSelfSteer`, never on `isAgent` — `isAgent` depends on the
    // roster and goes false exactly where a Corner needs this most, which is
    // how a full push-rejection dump reached the slab.
    expect(branch).toContain(
      'const ledgerText = isSelfSteer ? undefined : splitLedgerText(item.text)',
    );
    expect(branch).not.toMatch(/isAgent \? splitLedgerText/);
    expect(branch).toMatch(/<LedgerGhostLine[\s\S]{0,200}lines of tool output/);
    expect(branch).toMatch(/bodyText=\{ledgerText \? ledgerText\.prose : item\.text\}/);
  });

  it('shows an agent reply reference only when its target is not adjacent', () => {
    const branch = ledgerBranch();
    // The helper preserves the quiet linear request → reply pair while exposing
    // a queued reply's real NIP-10 target. Human reply behavior stays unchanged.
    expect(branch).toContain('shouldShowReplyReference({');
    expect(branch).toContain(
      'immediatelyPrecedingMessage: immediatelyPrecedingVisibleMessageById.get(item.id)',
    );
    expect(branch).toMatch(
      /showReplyReference && item\.replyToId \? visibleMessageById\.get\(item\.replyToId\)/,
    );
    expect(branch).toMatch(/replyReference =\s*\n?\s*showReplyReference \?/);
    expect(branch).toMatch(/<LedgerEntry[\s\S]{0,1000}replyReference=\{replyReference\}/);
  });

  it('keeps wire interpretation outside the presentation adapter', () => {
    const projection = readFileSync(
      new URL('../../sync/transport/buzz-event-projection.ts', import.meta.url),
      'utf8',
    );
    expect(projection).toContain('selectTranscript');
    expect(projection).not.toMatch(/\.tags\b|\.content\b/);
    expect(projection).not.toMatch(/classifySessionEvent|projectChatEvent|roomMessage/);
  });

  it('keeps the shared transcript surface on one pure snapshot selector', () => {
    const projection = readFileSync(
      new URL('../../sync/transport/buzz-event-projection.ts', import.meta.url),
      'utf8',
    );
    const fn = projection.slice(projection.indexOf('export function transcriptMessages'));
    expect(fn).toMatch(/selectTranscript\(snapshot, channelId, input\)/);
    expect(fn).not.toMatch(/event\.tags|event\.content|isCorner/);
    expect(fn).toContain("item.kind === 'human-message'");
    expect(fn).toContain("item.kind === 'activity'");
  });
});

describe('Archived corner record', () => {
  it('retires the archived card in favor of the structural closed update', () => {
    const branchStart = chatSource.indexOf('      if (item.corner) {');
    expect(branchStart).toBeGreaterThanOrEqual(0);
    const branch = chatSource.slice(
      branchStart,
      chatSource.indexOf('// ── Archived notice', branchStart),
    );
    expect(branch).toContain('return null');
    expect(chatSource).not.toContain('archived-corner-summary');
    expect(chatSource).toContain('<LedgerRoomUpdate');
  });
});

describe('Corner header identity', () => {
  it('never falls back to the Room label while a corner is loading', () => {
    expect(chatSource).toContain('channelHeaderTitle(');
    expect(chatSource).toContain('testID="chat-title-skeleton"');
    // The header renders `headerTitle`, which is null-for-skeleton, never a
    // ROOM_LABEL default baked into the name state.
    expect(chatSource).not.toMatch(/useState\([^)]*roomName\s*\?\?\s*ROOM_LABEL/);
    expect(chatSource).not.toMatch(/setRoomName\(/);
    expect(chatSource).not.toMatch(/roomName:\s*channelMetadata\?\.name\?\.trim\(\)\s*\|\|/);
  });

  it('resolves the name off its own read instead of behind the transcript backfill', () => {
    // getChannelMetadata + getParentChannelId are their own reads, started with
    // every other enter-room read and committed the moment each one lands —
    // never batched behind the transcript backfill, the empty-room retry, or a
    // subscription handshake.
    expect(roomEntrySource).toMatch(
      /const parentIdRead = transport\.getParentChannelId\(channelId\)/,
    );
    expect(roomEntrySource).toMatch(/const metadataRead = client\.getChannelMetadata\(channelId\)/);
    expect(roomEntrySource).toMatch(/step\('roomName', metadataRead,/);
    expect(roomEntrySource).toMatch(/step\('parentChannelId', parentIdRead,/);
    // ...and each is read exactly once, then shared by every dependent step.
    expect(roomEntrySource.match(/client\.getChannelMetadata\(/g)?.length).toBe(1);
    expect(roomEntrySource.match(/transport\.getParentChannelId\(/g)?.length).toBe(1);
    // The screen commits the channel's own name and kind straight off them.
    expect(chatSource).toMatch(
      /onRoomName: \(name\) => \{[\s\S]{0,120}setResolvedChannelName\(name\)/,
    );
    expect(chatSource).toMatch(
      /onParentChannelId: \(parentId\) => \{[\s\S]{0,160}setChannelKind\(parentId \? 'corner' : 'room'\)/,
    );
  });
});

describe('Leaving a corner', () => {
  it('routes back by parent id, never by a bare stack pop', () => {
    expect(chatSource).toContain('onPress={handleBack}');
    expect(chatSource).toContain('chatBackAction(routes, parentChannelId, cornerReturnTarget)');
    // The only surviving `router.back()` is inside handleBack's own 'back' case.
    expect(chatSource.match(/router\.back\(\);/g)?.length).toBe(1);
    expect(chatSource).toMatch(/action\.type === 'back'\) router\.back\(\)/);
  });

  it('cannot open the corner it is already showing', () => {
    expect(chatSource).toMatch(/openCorner[\s\S]{0,200}subchannelId === decodedId\) return/);
    // Every corner push goes through openCorner, so each one carries its parent.
    expect(chatSource).not.toMatch(
      /router\.push\(`\/buzz\/chat\/\$\{encodeURIComponent\(item\.corner/,
    );
    expect(chatSource).not.toMatch(
      /router\.push\(`\/buzz\/chat\/\$\{encodeURIComponent\(tappableCornerId/,
    );
  });
});

describe('The corner review footer never claims a retry the daemon is not making', () => {
  /** The `approvalState === 'failed'` branch of the review panel. */
  function failedBranch(): string {
    const start = chatSource.indexOf("approvalState === 'failed' ? (");
    expect(start, 'missing the failed branch of the review panel').toBeGreaterThanOrEqual(0);
    const end = chatSource.indexOf('testID="approve-corner-error"', start);
    expect(end, 'failed branch is not followed by the approval-error line').toBeGreaterThan(start);
    return chatSource.slice(start, end);
  }

  it('gates the automatic-retry wording on the daemon’s own retry posture', () => {
    const branch = failedBranch();
    // The string may exist — but only under `deliveryRetry === 'auto'`, the
    // one posture where `pollDirectRemoteApprovals` really does re-attempt the
    // same approval on the next maintenance tick.
    expect(branch).toContain("deliveryRetry === 'auto'");
    const retryClaims = branch.match(/RETRYING AUTOMATICALLY/g) ?? [];
    expect(retryClaims).toHaveLength(1);
    expect(branch.indexOf("deliveryRetry === 'auto'")).toBeLessThan(
      branch.indexOf('RETRYING AUTOMATICALLY'),
    );
  });

  it('says what is actually happening for the other three postures', () => {
    const branch = failedBranch();
    // A moved target being rebased, a land nobody is re-attempting, and a
    // daemon that did not say — none of which may read as "retrying".
    expect(branch).toContain("deliveryRetry === 'realigning'");
    expect(branch).toContain('UPDATING THIS CHANGE FOR A NEW REVIEW');
    expect(branch).toContain("deliveryRetry === 'blocked'");
    expect(branch).toContain('WAITING ON YOU');
    expect(branch).toContain('SEE THE CORNER FOR DETAILS');
  });

  it('drops the failure state as soon as a fresh reviewable tip arrives', () => {
    // Otherwise the self-heal's whole point is lost: the corner rebases,
    // republishes a review, and the panel still shows the old attempt's
    // failure instead of the approve button for the new change.
    expect(chatSource).toContain('mergeTargetTipRef');
    const live = chatSource.slice(chatSource.indexOf('const flushLiveEvents = () => {'));
    expect(live).toContain('mergeTargetTipRef.current !== projected.mergeTarget.tip');
    expect(live).toContain('setDeliveryRetry(undefined)');
    expect(live).toContain('setDeliveryRetry(projected.deliveryRetry)');
  });
});

describe('The merge approval card exposes every durable state', () => {
  it('acknowledges the tap locally before the daemon answers', () => {
    expect(chatSource).toContain("setApprovalState('sent')");
    expect(chatSource).toContain('APPROVAL SENT ✓');
    expect(chatSource).toContain('WAITING FOR THE AGENT TO PICK IT UP');
  });

  it('distinguishes landing from realignment with the standing approval', () => {
    expect(chatSource).toContain('APPROVAL RECEIVED — LANDING…');
    expect(chatSource).toContain('REALIGNED — LANDING WITH YOUR EXISTING APPROVAL…');
    expect(chatSource).toContain('testID="approve-corner-realigned"');
  });

  it('surfaces the one-minute no-ack timeout instead of hanging', () => {
    expect(chatSource).toContain("current === 'sent' ? 'timeout' : current");
    expect(chatSource).toContain('THE AGENT HASN’T PICKED IT UP YET · OFFLINE?');
    expect(chatSource).toContain('approvalTimeoutMessage()');
  });

  it('keeps the concrete daemon failure without inventing a re-approval path', () => {
    expect(chatSource).toContain('projected.deliveryFailureReason');
    expect(chatSource).toContain('projected.message?.text');
    expect(chatSource).not.toContain('approvalNeedsReapprove');
    expect(chatSource).not.toContain('RE-APPROVE UPDATED CHANGE');
  });

  it('states that approval covers this corner’s ongoing work until it lands', () => {
    expect(chatSource).toContain('APPROVE THIS CORNER’S MERGE');
    expect(chatSource).toContain('COVERS ITS ONGOING WORK UNTIL IT LANDS');
    expect(chatSource).not.toContain('APPROVAL APPLIES ONLY TO THIS REVIEWED CHANGE');
  });

  it('binds the terminal success card to the landed SHA', () => {
    expect(chatSource).toContain('setLandedApprovalTip(projected.landedTip');
    expect(chatSource).toContain(
      "LANDED AT {(landedApprovalTip ?? mergeTarget?.tip ?? '').slice(0, 12)} ✓",
    );
  });
});

describe('The change-ready review card', () => {
  it('describes the change, never re-prints the turn narration', () => {
    // The card sat directly above the diff and rendered the corner's last
    // agent message — the concise reduction of prose the transcript already
    // carries in full, so the same sentences appeared a third time. Its line
    // now comes from the reviewed manifest instead.
    expect(chatSource).toContain('changeReviewSummary(reviewFiles)');
    expect(chatSource).not.toContain('latestCornerTurnSummary');
    expect(chatSource).not.toContain('turnSummary');
  });

  it('never guesses a file count before the manifest lands', () => {
    // "not loaded yet" and "nothing changed" are different answers.
    expect(chatSource).toContain(
      "reviewFiles === null\n                          ? 'PREPARING YOUR REVIEW'",
    );
  });
});

/**
 * The client-side "X seems offline" notice is DELETED, by the captain's order.
 *
 * It was a client-rendered guess about another machine, inserted into the
 * reader's own transcript, and it fired twice on a live device for an agent
 * the reader had not addressed. Every gate it grew — addressee, presence
 * resolution, repeat window — narrowed when it lied without ever making it
 * true. The Room's own OFFLINE banner and the per-agent presence dot remain:
 * those report a lease the daemon itself publishes rather than inventing a
 * message from its absence.
 *
 * A source assertion, because this feature is easiest to reintroduce by
 * accident one helper at a time.
 */
describe('the client-side offline notice stays deleted', () => {
  const screen = chatSource;
  const presence = readFileSync(new URL('../../buzz/agent-presence.ts', import.meta.url), 'utf8');
  const ledger = readFileSync(new URL('./Ledger.tsx', import.meta.url), 'utf8');

  it('has no notice builder, gate, or repeat-window bookkeeping left', () => {
    for (const symbol of [
      'addressedAgentOfflineNotice',
      'offlineNoticeForSend',
      'offlineNoticeAddressee',
      'OFFLINE_NOTICE_REPEAT_WINDOW_MS',
      'offlineNoticedAtRef',
    ]) {
      expect(presence, `agent-presence.ts still defines ${symbol}`).not.toContain(symbol);
      expect(screen, `the chat screen still uses ${symbol}`).not.toContain(symbol);
    }
  });

  it('never writes the notice sentence into the transcript', () => {
    // The rendered copy, not prose about it — the comments explaining why the
    // feature is gone legitimately name the symptom it used to cause.
    for (const source of [screen, presence]) {
      expect(source).not.toContain('seems offline right now');
      expect(source).not.toContain('its host machine may be off');
    }
  });

  it('has no offline-queued marker on a human turn', () => {
    expect(ledger).not.toContain('offlineQueued');
    expect(ledger).not.toContain('AGENT OFFLINE');
    expect(screen).not.toContain('offlineQueuedIds');
  });
});

/**
 * A control the reader can see must act, or say why it cannot.
 *
 * The chat screen paints from cache, so "■ CLOSE CORNER" is on screen well
 * before `transport` exists — and the handler opened with
 * `if (!transport) return`. Every press was then a silent no-op: nothing
 * published, nothing said, nothing to retry. Measured on the captain's Room:
 * the corner they pressed close on repeatedly had ZERO `buzz-corner-close`
 * events on the relay, so the daemon never had anything to act on. The bug was
 * never in the close path; it was that the close was never sent.
 */
describe('closing a corner never fails silently', () => {
  const handler = chatSource.slice(
    chatSource.indexOf('const handleCloseCorner = useCallback'),
    chatSource.indexOf('const handleApprove = useCallback'),
  );

  it('does not return without publishing and without telling anyone', () => {
    expect(handler).not.toContain('if (!transport) return;');
  });

  it('explains itself when the app has not connected yet', () => {
    expect(handler).toContain('Modal.alert');
    expect(handler).toMatch(/still connecting/i);
  });

  it('still reports a relay refusal rather than swallowing it', () => {
    expect(handler).toContain('Could not close corner');
  });
});
