import React, { useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { LedgerEntry } from './Ledger';
import { IdentityMark } from './IdentityMark';
import { ChevronGlyph } from './ChevronGlyph';
import { CornerGlyph } from './CornerGlyph';
import { Button } from './Button';
import { HullModal } from './HullDialog';
import { welcomeBrandMarks } from './welcome-brand-marks';
import { WelcomeToolMark } from './WelcomeToolMark';
import { completeWelcomeCards } from '@/buzz/welcome-cards';
import { space } from '@/buzz/groknight';

// Welcome is a sheet in the app's own language: every colour, radius, type
// role and spacing step comes from the active theme (Obsidian or Bone).
const STEP_DOT = 6;
const STEP_ACTIVE_WIDTH = 22;
const TOOL_NAMES = [
  'gmail',
  'googlecalendar',
  'googledrive',
  'googledocs',
  'googlesheets',
  'github',
  'stripe',
  'slack',
  'notion',
  'linear',
  'figma',
  'cloudflare',
  'vercel',
  'neon',
  'supabase',
  'gitlab',
  'sentry',
  'airtable',
  'caldotcom',
  'googlemeet',
  'hubspot',
  'shopify',
  'dropbox',
  'coinbase',
  'tailscale',
] as const;
const COPY = [
  {
    title: 'One Room for your team and your agents',
    body: 'Mention anyone, person or agent. Everyone works from the same thread, so agents pick up right where people leave off.',
  },
  {
    title: 'Work happens in corners',
    body: 'Ask for something and an agent opens a corner. It plans, builds, runs the checks and brings you one thing to approve.',
  },
  {
    title: 'Any model, any harness',
    body: 'Bring Claude, GPT, Gemini or DeepSeek, running in Claude Code, Codex, Pi and more. Mix them in one Room and switch anytime.',
  },
  {
    title: 'All your tools, ready for your agents',
    body: 'Connect an app once in Workbench. Agents can also ask you to connect an app from a conversation when they need one.',
  },
] as const;

/** The sample conversations below are fixtures. Their cells are the actual Room/Corner Ledger. */
function SampleEntry({
  name,
  role,
  text,
  stamp,
  seed,
  kind = 'agent',
  viewer = false,
}: {
  name: string;
  role?: string;
  text: string;
  stamp: string;
  seed: string;
  kind?: 'human' | 'agent';
  viewer?: boolean;
}) {
  return (
    <LedgerEntry
      itemId={`welcome-${seed}-${stamp}`}
      bodyText={text}
      bodyTestID={`welcome-message-${seed}`}
      chronological
      mentionHandles={['monarch', 'dani', 'speedy']}
      byline={{ name, role, stamp, isViewer: viewer, mark: { seed, kind } }}
    />
  );
}

function RoomScene() {
  const { theme } = useUnistyles();
  return (
    <View style={scene.shell} testID="welcome-room-scene">
      <View style={scene.header}>
        <ChevronGlyph color={theme.buzz.textPrimary} direction="left" size={22} />
        <Text style={scene.roomTitle}>#growth</Text>
        <CornerGlyph color={theme.buzz.accent} size={18} />
      </View>
      <View style={scene.transcript}>
        <SampleEntry
          name="dani"
          text="@monarch can you pull last week’s signups into a sheet?"
          stamp="09:12"
          seed={'1'.repeat(64)}
          kind="human"
          viewer
        />
        <SampleEntry
          name="Monarch"
          role="claude-opus-5.5"
          text="Done. The sheet is in Drive: signups-last-week"
          stamp="09:13"
          seed={'2'.repeat(64)}
        />
        <SampleEntry
          name="Speedy"
          role="AGENT · gpt-6-sol"
          text="@dani I flagged the two days that dipped."
          stamp="09:14"
          seed={'3'.repeat(64)}
        />
      </View>
      <View style={scene.composer}>
        <Text style={scene.placeholder}>Message</Text>
      </View>
    </View>
  );
}

function CornerScene() {
  const { theme } = useUnistyles();
  return (
    <View style={scene.shell} testID="welcome-corner-scene">
      <View style={scene.header}>
        <ChevronGlyph color={theme.buzz.textPrimary} direction="left" size={22} />
        <IdentityMark seed={'3'.repeat(64)} kind="agent" size={28} />
        <View style={{ flex: 1 }}>
          <Text style={scene.cornerTitle}>#app/Sign-in retry</Text>
          <Text style={scene.cornerState}>SPEEDY · review</Text>
        </View>
      </View>
      <View style={scene.transcript}>
        <Text style={scene.quote}>
          Make sign-in retry cleanly after a failed or cancelled attempt; add a regression test.
        </Text>
        <Text style={scene.pr}>
          PR #1861 · all 31 checks passed <Text style={scene.accent}>↗</Text>
        </Text>
        <SampleEntry
          name="lunchboxfortwo"
          text="@speedy make sign-in retry cleanly after a failed attempt"
          stamp="09:31"
          seed={'4'.repeat(64)}
          kind="human"
          viewer
        />
        <SampleEntry
          name="Speedy"
          role="AGENT · gpt-6-sol"
          text="Ready for your review."
          stamp="09:40"
          seed={'3'.repeat(64)}
        />
      </View>
      <View style={scene.cornerRow}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={scene.rowCaption}>IN #APP, ONE ROW</Text>
          <Text style={scene.rowStatus}>REVIEW ●</Text>
        </View>
        <Text style={scene.rowName}>#app/Sign-in retry · Opened by Speedy</Text>
      </View>
    </View>
  );
}

const AGENTS = [
  { name: 'Monarch', model: 'Claude Opus 5.5 · Claude Code', logo: 'anthropic' },
  { name: 'Speedy', model: 'GPT-6 Sol · Codex', logo: 'openai' },
  { name: 'Nerd', model: 'Gemini · Pi', logo: 'googlegemini' },
  { name: 'Echo', model: 'DeepSeek V4.1 Flash · Pi', logo: 'deepseek' },
] as const;
function ModelScene() {
  const { theme } = useUnistyles();
  return (
    <View style={scene.collection} testID="welcome-model-scene">
      <Text style={scene.collectionCaption}>AGENTS IN THIS WORKSPACE</Text>
      {AGENTS.map((agent) => (
        <View key={agent.name} style={scene.agentRow}>
          {/* Monochrome Simple Icons marks: the ink follows the theme so they
              stay legible on Obsidian (unfilled paths would paint black). */}
          <SvgXml
            xml={welcomeBrandMarks[agent.logo]}
            width={22}
            height={22}
            fill={theme.buzz.textPrimary}
          />
          <View>
            <Text style={scene.agentName}>{agent.name}</Text>
            <Text style={scene.agentMeta}>{agent.model}</Text>
          </View>
        </View>
      ))}
      <Text style={scene.agentFoot}>Four models, three harnesses, one Room.</Text>
    </View>
  );
}

function ToolsScene() {
  return (
    <View style={scene.tools} testID="welcome-tools-scene">
      {TOOL_NAMES.map((name) => (
        <View key={name} style={scene.toolCell} accessibilityLabel={name}>
          <WelcomeToolMark name={name} />
        </View>
      ))}
    </View>
  );
}

export function WelcomeCards({ visible, onDone }: { visible: boolean; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const desktop = width >= 1024;
  const wideCanvas = width >= 768;
  const sceneHeight = desktop
    ? 572
    : wideCanvas
      ? index < 2
        ? 610
        : 430
      : Math.min(index < 2 ? 480 : 430, Math.max(270, height * 0.57));
  const next = async () => {
    if (index < 3) {
      setIndex(index + 1);
      return;
    }
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await completeWelcomeCards();
      onDone();
    } catch {
      setError('Could not save your welcome progress. Try again.');
    } finally {
      setWorking(false);
    }
  };
  const illustration =
    index === 0 ? (
      <RoomScene />
    ) : index === 1 ? (
      <CornerScene />
    ) : index === 2 ? (
      <ModelScene />
    ) : (
      <ToolsScene />
    );
  const footer = (
    <View style={card.footer}>
      <View style={card.steps}>
        {COPY.map((_, i) => (
          <View key={i} style={[card.step, i === index && card.stepActive]} />
        ))}
      </View>
      <Button
        label={index === 3 ? 'Get started' : 'Next'}
        onPress={() => void next()}
        disabled={working}
        accessibilityLabel={index === 3 ? 'Get started' : 'Next'}
        style={card.next}
        testID="welcome-next"
      />
    </View>
  );
  return (
    <HullModal
      visible={visible}
      animationType="fade"
      onRequestClose={() => undefined}
      dismissOnBackdrop={false}
      keyboardAvoiding={false}
      placement="fill"
    >
      <View
        style={[
          card.page,
          {
            paddingTop: Math.max(insets.top, space.xl),
            paddingBottom: Math.max(insets.bottom, space.xl),
          },
          desktop && card.desktopPage,
        ]}
        testID="welcome-cards"
      >
        <View
          style={[
            card.content,
            { maxWidth: desktop ? 960 : wideCanvas ? 600 : Math.min(390, width) },
            desktop ? card.desktopContent : wideCanvas && { justifyContent: 'center' },
          ]}
        >
          <View style={[{ height: sceneHeight }, desktop && card.desktopScene]}>
            {illustration}
          </View>
          {desktop ? (
            <View style={card.desktopRight}>
              <View style={card.copy}>
                <Text style={card.title}>{COPY[index].title}</Text>
                <Text style={card.body}>{COPY[index].body}</Text>
              </View>
              <View style={{ flex: 1 }} />
              {error && <Text style={card.error}>{error}</Text>}
              {footer}
            </View>
          ) : (
            <>
              <View style={card.copy}>
                <Text style={card.title}>{COPY[index].title}</Text>
                <Text style={card.body}>{COPY[index].body}</Text>
              </View>
              {!wideCanvas && <View style={{ flex: 1 }} />}
              {error && <Text style={card.error}>{error}</Text>}
              {footer}
            </>
          )}
        </View>
      </View>
    </HullModal>
  );
}

const card = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    backgroundColor: theme.buzz.bgBase,
    alignItems: 'center',
    paddingHorizontal: theme.buzz.space.lg,
  },
  content: { flex: 1, width: '100%', gap: theme.buzz.space.lg },
  desktopPage: {
    justifyContent: 'center',
    paddingTop: theme.buzz.space.xl,
    paddingBottom: theme.buzz.space.xl,
  },
  desktopContent: {
    flex: 0,
    flexBasis: 620,
    height: 620,
    flexDirection: 'row',
    gap: theme.buzz.space.xl,
    padding: theme.buzz.space.lg,
    borderWidth: 1,
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgRaised,
  },
  desktopScene: { width: 480 },
  desktopRight: { width: 398, paddingTop: theme.buzz.space.md, paddingBottom: theme.buzz.space.md },
  copy: { gap: theme.buzz.space.sm },
  title: { ...theme.buzz.type.hero, color: theme.buzz.textPrimary },
  body: { ...theme.buzz.type.body, color: theme.buzz.textSecondary },
  error: { ...theme.buzz.type.meta, color: theme.buzz.dialogDanger },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  steps: { flexDirection: 'row', gap: theme.buzz.space.sm },
  step: {
    width: STEP_DOT,
    height: STEP_DOT,
    borderRadius: STEP_DOT / 2,
    backgroundColor: theme.buzz.borderStrong,
  },
  stepActive: { width: STEP_ACTIVE_WIDTH, backgroundColor: theme.buzz.textPrimary },
  next: { minWidth: 136 },
}));
const scene = StyleSheet.create((theme) => ({
  shell: {
    flex: 1,
    overflow: 'hidden',
    borderRadius: theme.buzz.radius,
    borderWidth: 1,
    borderColor: theme.buzz.border,
    backgroundColor: theme.buzz.bgBase,
  },
  header: {
    minHeight: 56,
    paddingHorizontal: theme.buzz.space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.buzz.border,
  },
  roomTitle: { ...theme.buzz.type.hero, flex: 1, color: theme.buzz.textPrimary },
  cornerTitle: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  cornerState: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  accent: { color: theme.buzz.accent },
  transcript: {
    flex: 1,
    paddingHorizontal: theme.buzz.space.md,
    paddingTop: theme.buzz.space.md,
  },
  composer: {
    margin: theme.buzz.space.md,
    minHeight: 40,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.transcriptCard.cornerRadius,
    justifyContent: 'center',
    paddingHorizontal: theme.buzz.space.md,
  },
  placeholder: { ...theme.buzz.type.body, color: theme.buzz.ledgerQuiet },
  quote: {
    ...theme.buzz.type.meta,
    color: theme.buzz.textSecondary,
    borderLeftWidth: 2,
    borderLeftColor: theme.buzz.accent,
    paddingLeft: theme.buzz.space.sm,
  },
  pr: {
    ...theme.buzz.type.machine,
    color: theme.buzz.textSecondary,
    marginTop: theme.buzz.space.md,
    marginBottom: theme.buzz.space.xs,
  },
  cornerRow: {
    paddingHorizontal: theme.buzz.space.md,
    paddingVertical: theme.buzz.space.sm,
    borderTopWidth: 1,
    borderTopColor: theme.buzz.border,
    gap: theme.buzz.space.xs,
  },
  rowCaption: { ...theme.buzz.type.sectionHead, color: theme.buzz.ledgerQuiet },
  rowName: { ...theme.buzz.type.meta, flex: 1, color: theme.buzz.textPrimary },
  rowStatus: { ...theme.buzz.type.sectionHead, color: theme.buzz.accent },
  collection: {
    flex: 1,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgRaised,
    padding: theme.buzz.space.md,
    gap: theme.buzz.space.sm,
  },
  collectionCaption: { ...theme.buzz.type.sectionHead, color: theme.buzz.ledgerQuiet },
  agentRow: {
    minHeight: 65,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgBase,
    paddingHorizontal: theme.buzz.space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
  },
  agentName: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  agentMeta: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  agentFoot: {
    ...theme.buzz.type.meta,
    color: theme.buzz.ledgerQuiet,
    marginHorizontal: theme.buzz.space.xs,
  },
  tools: {
    flex: 1,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgRaised,
    padding: theme.buzz.space.md,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignContent: 'space-between',
  },
  toolCell: {
    width: '18%',
    height: '18%',
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgBase,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
