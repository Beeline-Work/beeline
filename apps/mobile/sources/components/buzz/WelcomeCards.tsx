import React, { useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LedgerEntry } from './Ledger';
import { IdentityMark } from './IdentityMark';
import { ChevronGlyph } from './ChevronGlyph';
import { CornerGlyph } from './CornerGlyph';
import { HullModal } from './HullDialog';
import { welcomeBrandMarks } from './welcome-brand-marks';
import { WelcomeToolMark } from './WelcomeToolMark';
import { completeWelcomeCards } from '@/buzz/welcome-cards';

const INK = '#1C1712';
const PAPER = '#F3EDE3';
const DIM = '#4A4238';
const BRASS = '#8A6A2E';
const MONO = 'IBMPlexMono-Regular';
const SANS = 'SpaceGrotesk-Regular';
const MEDIUM = 'SpaceGrotesk-Medium';
// The approved mock defines this card's type scale. Keep its explicit sizes
// together while the app's transcript remains on its own shared type roles.
const WELCOME_TYPE = {
  size10: 10,
  size11: 11,
  size12: 12,
  size13: 13,
  size14: 14,
  size16: 16,
  size18: 18,
  size20: 20,
  size28: 28,
  size30: 30,
  trackingTight: -0.5,
  trackingLabel: 1,
  trackingWide: 2,
} as const;
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
  return (
    <View style={scene.shell} testID="welcome-room-scene">
      <View style={scene.header}>
        <ChevronGlyph color={INK} direction="left" size={22} />
        <Text style={scene.roomTitle}>#growth</Text>
        <CornerGlyph color={BRASS} size={18} />
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
  return (
    <View style={scene.shell} testID="welcome-corner-scene">
      <View style={scene.header}>
        <ChevronGlyph color={INK} direction="left" size={22} />
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
          PR #1861 · all 31 checks passed <Text style={{ color: BRASS }}>↗</Text>
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
  return (
    <View style={scene.collection} testID="welcome-model-scene">
      <Text style={scene.collectionCaption}>AGENTS IN THIS WORKSPACE</Text>
      {AGENTS.map((agent) => (
        <View key={agent.name} style={scene.agentRow}>
          <SvgXml xml={welcomeBrandMarks[agent.logo]} width={22} height={22} />
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
  const sceneHeight = Math.min(index < 2 ? 480 : 430, Math.max(270, height * 0.57));
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
          { paddingTop: Math.max(insets.top, 28), paddingBottom: Math.max(insets.bottom, 30) },
        ]}
        testID="welcome-cards"
      >
        <View style={[card.content, { maxWidth: Math.min(390, width) }]}>
          <View style={{ height: sceneHeight }}>
            {index === 0 ? (
              <RoomScene />
            ) : index === 1 ? (
              <CornerScene />
            ) : index === 2 ? (
              <ModelScene />
            ) : (
              <ToolsScene />
            )}
          </View>
          <View style={card.copy}>
            <Text style={card.title}>{COPY[index].title}</Text>
            <Text style={card.body}>{COPY[index].body}</Text>
          </View>
          <View style={{ flex: 1 }} />
          {error && <Text style={card.error}>{error}</Text>}
          <View style={card.footer}>
            <View style={card.steps}>
              {COPY.map((_, i) => (
                <View key={i} style={[card.step, i === index && card.stepActive]} />
              ))}
            </View>
            <Pressable
              onPress={() => void next()}
              disabled={working}
              accessibilityRole="button"
              accessibilityLabel={index === 3 ? 'Get started' : 'Next'}
              style={card.next}
              testID="welcome-next"
            >
              <Text style={card.nextText}>{index === 3 ? 'Get started' : 'Next'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </HullModal>
  );
}

const card = {
  page: { flex: 1, backgroundColor: PAPER, alignItems: 'center' as const, paddingHorizontal: 24 },
  content: { flex: 1, width: '100%' as const, gap: 26 },
  copy: { gap: 12 },
  title: {
    color: INK,
    fontFamily: MEDIUM,
    fontSize: WELCOME_TYPE.size30,
    lineHeight: 36,
    letterSpacing: WELCOME_TYPE.trackingTight,
  },
  body: { color: DIM, fontFamily: SANS, fontSize: WELCOME_TYPE.size16, lineHeight: 24 },
  error: { color: '#A8514D', fontFamily: SANS, fontSize: WELCOME_TYPE.size13 },
  footer: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
  },
  steps: { flexDirection: 'row' as const, gap: 8 },
  step: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#CFC3B0' },
  stepActive: { width: 22, backgroundColor: INK },
  next: {
    minHeight: 48,
    minWidth: 120,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: INK,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  nextText: { color: PAPER, fontFamily: MEDIUM, fontSize: WELCOME_TYPE.size16 },
};
const scene = {
  shell: {
    flex: 1,
    overflow: 'hidden' as const,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#DCCFBB',
    backgroundColor: PAPER,
  },
  header: {
    minHeight: 56,
    paddingHorizontal: 16,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#E2D9CB',
  },
  roomTitle: { flex: 1, color: INK, fontFamily: MEDIUM, fontSize: WELCOME_TYPE.size20 },
  cornerTitle: { color: INK, fontFamily: MEDIUM, fontSize: WELCOME_TYPE.size16 },
  cornerState: {
    color: BRASS,
    fontFamily: MONO,
    fontSize: WELCOME_TYPE.size10,
    letterSpacing: WELCOME_TYPE.trackingLabel,
  },
  transcript: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  composer: {
    margin: 14,
    minHeight: 40,
    borderWidth: 1,
    borderColor: '#B8A27A',
    borderRadius: 12,
    justifyContent: 'center' as const,
    paddingHorizontal: 14,
  },
  placeholder: { color: '#6F6558', fontFamily: SANS, fontSize: WELCOME_TYPE.size14 },
  quote: {
    color: '#3A332B',
    fontFamily: SANS,
    fontSize: WELCOME_TYPE.size13,
    lineHeight: 19,
    borderLeftWidth: 2,
    borderLeftColor: BRASS,
    paddingLeft: 10,
  },
  pr: {
    color: '#3A332B',
    fontFamily: MONO,
    fontSize: WELCOME_TYPE.size11,
    marginTop: 14,
    marginBottom: 4,
  },
  cornerRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#E2D9CB',
    gap: 4,
  },
  rowCaption: {
    fontFamily: MONO,
    fontSize: WELCOME_TYPE.size10,
    letterSpacing: WELCOME_TYPE.trackingWide,
    color: '#6F6558',
  },
  rowName: { flex: 1, fontFamily: SANS, fontSize: WELCOME_TYPE.size13, color: INK },
  rowStatus: {
    fontFamily: MONO,
    fontSize: WELCOME_TYPE.size10,
    letterSpacing: WELCOME_TYPE.trackingLabel,
    color: BRASS,
  },
  collection: { flex: 1, borderRadius: 22, backgroundColor: '#EDE5D8', padding: 18, gap: 10 },
  collectionCaption: {
    fontFamily: MONO,
    fontSize: WELCOME_TYPE.size11,
    letterSpacing: WELCOME_TYPE.trackingWide,
    color: '#6F6558',
  },
  agentRow: {
    minHeight: 65,
    borderRadius: 14,
    backgroundColor: '#FBF8F2',
    paddingHorizontal: 14,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
  },
  agentName: { fontFamily: MEDIUM, fontSize: WELCOME_TYPE.size16, color: INK },
  agentMeta: { fontFamily: SANS, fontSize: WELCOME_TYPE.size12, color: '#6F6558' },
  agentFoot: {
    fontFamily: SANS,
    fontSize: WELCOME_TYPE.size12,
    color: '#6F6558',
    marginHorizontal: 4,
  },
  tools: {
    flex: 1,
    borderRadius: 22,
    backgroundColor: '#EDE5D8',
    padding: 18,
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    justifyContent: 'space-between' as const,
    alignContent: 'space-between' as const,
  },
  toolCell: {
    width: '18%' as const,
    height: '18%' as const,
    borderRadius: 14,
    backgroundColor: '#FBF8F2',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
};
