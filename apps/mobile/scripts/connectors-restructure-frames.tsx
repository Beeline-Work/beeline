import React from 'react';
// @ts-expect-error Isolated render proof uses installed react-dom without production type declarations.
import { createRoot } from 'react-dom/client';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { PageHeader } from '../sources/components/buzz/PageHeader';
import { ServiceMark } from '../sources/components/buzz/ServiceMark';
import { SettingsRow } from '../sources/components/buzz/SettingsRow';
import { ToolDetailsCell } from '../sources/components/buzz/ToolDetailsCell';
import { ChevronGlyph } from '../sources/components/buzz/ChevronGlyph';
import { HullActionSheet, HullActionSheetCancel, HullActionSheetRow } from '../sources/components/buzz/HullActionSheet';
import { Typography } from '../sources/constants/Typography';

const nothing = () => undefined;
const frame = new URLSearchParams(window.location.search).get('frame') ?? 'home';

function Mark({ name, domain }: { name: string; domain?: string }) {
  return <ServiceMark company={name} domain={domain} />;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <View style={styles.section}><Text style={styles.sectionLabel}>{title}</Text>{children}</View>;
}

function Body({ title, eyebrow = 'Connectors', children, tall = false }: {
  title: string; eyebrow?: string; children: React.ReactNode; tall?: boolean;
}) {
  return <View style={styles.screen}>
    <PageHeader eyebrow={eyebrow} prominent title={title} onBack={nothing} />
    <ScrollView contentContainerStyle={[styles.content, tall && styles.tallContent]}>{children}</ScrollView>
  </View>;
}

function Primary({ label }: { label: string }) {
  return <TouchableOpacity accessibilityRole="button" onPress={nothing} style={styles.primary}><Text style={styles.primaryText}>{label}</Text></TouchableOpacity>;
}

function Connection({ name, domain, subtitle, value }: {
  name: string; domain?: string; subtitle: string; value: string;
}) {
  return <SettingsRow appBoard chevron="right" leading={<Mark name={name} domain={domain} />} title={name} description={subtitle} value={value} valueTone={value === 'Offline' ? 'danger' : undefined} statusGlyph={value === 'Connected' ? 'live' : value === 'Offline' ? 'failed' : undefined} onPress={nothing} trailingPress={{ accessibilityLabel: `${name}: ${value}. Change connection`, onPress: nothing }} />;
}

function SearchBar({ value = '' }: { value?: string }) {
  return <View style={styles.search}>
    <Text style={styles.searchIcon}>⌕</Text>
    <TextInput accessibilityLabel="Search connections" value={value} editable={false} placeholder="Search apps, keys, and websites" placeholderTextColor={styles.placeholder.color} style={styles.searchInput} />
  </View>;
}

function Home({ squireState = 'never' }: { squireState?: 'never' | 'connected' | 'offline' }) {
  const recommended: readonly [string, string, string?][] = [
    ['Link', 'Approve agent purchases with Link', 'link.com'],
    ['Linear', 'Sign in to manage issues', 'linear.app'],
    ['Instagram', 'Sign in to your account', 'instagram.com'],
    ['Slack', 'Sign in to your workspace', 'slack.com'],
    ['Calendar', 'Sign in to your calendar', 'calendar.google.com'],
    ['Drive', 'Sign in to your files', 'drive.google.com'],
    ['Jira', 'Sign in to manage projects', 'atlassian.com'],
    ['TikTok', 'Sign in to TikTok', 'tiktok.com'],
  ];
  return <Body title="Connectors" eyebrow="Settings" tall>
    <SearchBar />
    <Section title="YOUR CONNECTIONS">
      {squireState === 'connected' ? <>
        <Connection name="Trusty Squire" subtitle="Hands-off sign-in · 4 keys" value="Connected" />
        <SettingsRow appBoard chevron="right" title="Stripe" description="Key · Trusty Squire" leading={<Mark name="Stripe" domain="stripe.com" />} />
        <SettingsRow appBoard chevron="right" title="OpenRouter" description="2 keys · Trusty Squire" leading={<Mark name="OpenRouter" domain="openrouter.ai" />} />
        <SettingsRow appBoard chevron="right" title="Rakuten Ichiba" description="Key · Trusty Squire" leading={<Mark name="Rakuten Ichiba" domain="rakuten.co.jp" />} />
      </> : squireState === 'offline' ? <>
        <Connection name="Trusty Squire" subtitle="Hands-off sign-in · 4 keys" value="Offline" />
        <Connection name="Stripe" domain="stripe.com" subtitle="Key · Trusty Squire" value="Offline" />
        <Connection name="OpenRouter" domain="openrouter.ai" subtitle="2 keys · Trusty Squire" value="Offline" />
        <Connection name="Rakuten Ichiba" domain="rakuten.co.jp" subtitle="Key · Trusty Squire" value="Offline" />
      </> : null}
      <Connection name="Gmail" domain="gmail.com" subtitle="Signed in" value="Connected" />
      <Connection name="Tailscale" domain="tailscale.com" subtitle="Network · Tailscale" value="Connected" />
      <Connection name="Coinbase wallet" domain="coinbase.com" subtitle="Wallet" value="Connected" />
    </Section>
    <Section title="RECOMMENDED">
      {squireState === 'never' ? <View style={styles.hero}>
        <ToolDetailsCell appBoard expanded action="Connect" onAction={nothing} detailText="Signs up and signs in for your agents" leading={<View style={styles.squireMark}><Text style={styles.squireText}>{'{ }'}</Text></View>} testID="squire-hero" title="Trusty Squire" />
        <Text style={styles.heroMeta}>Any website, hands-off. Its vault holds keys when needed.</Text>
      </View> : null}
      {recommended.map(([name, subtitle, domain]) => <SettingsRow appBoard chevron="right" key={name} title={name} description={subtitle} leading={<Mark name={name} domain={domain} />} />)}
    </Section>
  </Body>;
}

function SearchResults() {
  return <Body title="Search" tall>
    <SearchBar value="stripe" />
    <Section title="RECOMMENDED FOR STRIPE">
      <TouchableOpacity accessibilityRole="button" onPress={nothing} style={styles.searchRecommendation}>
        <Mark name="Stripe" domain="stripe.com" />
        <View style={styles.fallbackCopy}>
          <Text style={styles.fallbackTitle}>Sign in to Stripe</Text>
          <Text style={styles.fallbackDescription}>Review and approve access</Text>
        </View>
        <ChevronGlyph direction="right" size={18} color={styles.fallbackDescription.color} />
      </TouchableOpacity>
    </Section>
    <TouchableOpacity accessibilityRole="button" onPress={nothing} style={styles.otherWays}>
      <Text style={styles.otherWaysLabel}>Other sign-in or Trusty Squire</Text>
      <Text style={styles.otherWaysCount}>2 ways</Text>
      <ChevronGlyph direction="down" size={18} color={styles.fallbackDescription.color} />
    </TouchableOpacity>
  </Body>;
}

function Status({ value }: { value: string }) {
  return <SettingsRow title="Status" value={value} valueTone={value === 'Offline' ? 'danger' : undefined} trailingPress={{ accessibilityLabel: `${value}. Change connection`, onPress: nothing }} />;
}

function Explainer({ text, examples }: { text: string; examples: string[] }) {
  return <Section title="WHAT YOUR AGENTS CAN DO">
    <Text style={styles.explainer}>{text}</Text>
    {examples.map((example) => <View style={styles.example} key={example}><Text style={styles.quote}>“{example}”</Text></View>)}
  </Section>;
}

function KeyRow({ label }: { label: string }) {
  return <SettingsRow title={label} />;
}

function KeyService() {
  return <Body title="OpenRouter" tall>
    <View style={styles.identity}><Mark name="OpenRouter" domain="openrouter.ai" /><Text style={styles.provenance}>2 keys · Trusty Squire</Text></View>
    <Explainer text="Let agents use the OpenRouter account you choose, within the access you allow." examples={['Compare models for this task', 'Show my API usage', 'List the models I can use']} />
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>YOUR KEYS</Text>
      <KeyRow label="default" />
      <KeyRow label="beeline" />
    </View>
    <SettingsRow chevron="right" title="Manage in Trusty Squire" onPress={nothing} />
  </Body>;
}

function ConnectionActionsFrame() {
  return <View style={styles.sheetScene}>
    <View style={styles.dimmed}><SignInService /></View>
    <View style={styles.sheetBottom}><HullActionSheet title="Gmail">
      <HullActionSheetRow label="Disconnect" destructive onPress={nothing} />
      <HullActionSheetCancel onPress={nothing} />
    </HullActionSheet></View>
  </View>;
}

function SignInService() {
  return <Body title="Gmail">
    <View style={styles.identity}><Mark name="Gmail" domain="gmail.com" /><Text style={styles.provenance}>Signed in · Google</Text></View>
    <Status value="Connected" />
    <Explainer text="Let agents work with your mail when you ask them to." examples={['Find the latest invoice', 'Draft a reply to Alex', 'Send the reply I approved']} />
  </Body>;
}

function SquireDetail() {
  return <Body title="Trusty Squire" tall>
    <Text style={styles.explainer}>Trusty Squire signs up and signs in to websites for your agents, so you never do the manual login. It keeps keys it obtains in its vault.</Text>
    <Status value="Connected" />
    <Explainer text="Ask your agent to use a site and Squire handles the login steps." examples={['Sign me up for this service', 'Sign in and finish this task']} />
  </Body>;
}

function WalletDetail() {
  return <Body title="Coinbase wallet">
    <View style={styles.identity}><Mark name="Coinbase" domain="coinbase.com" /><Text style={styles.provenance}>Wallet</Text></View>
    <Status value="Connected" />
    <Explainer text="Your agents can prepare wallet actions within the permissions you grant. You review spending before it happens." examples={['Show my balance', 'Prepare a transfer', 'Show recent activity']} />
    <Primary label="Open wallet" />
    <Text style={styles.note}>Opens the Coinbase wallet frontend.</Text>
  </Body>;
}

function OfflineKeyService() {
  return <Body title="OpenRouter">
    <View style={styles.identity}><Mark name="OpenRouter" domain="openrouter.ai" /><Text style={styles.provenance}>2 keys · Trusty Squire</Text></View>
    <Status value="Offline" />
    <Text style={styles.explainer}>Trusty Squire is offline. Reconnect it to use these keys.</Text>
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>YOUR KEYS</Text>
      <KeyRow label="default" />
      <KeyRow label="beeline" />
    </View>
    <SettingsRow chevron="right" title="Manage in Trusty Squire" onPress={nothing} />
  </Body>;
}

function OfflineKeyActionsFrame() {
  return <View style={styles.sheetScene}>
    <View style={styles.dimmed}><OfflineKeyService /></View>
    <View style={styles.sheetBottom}><HullActionSheet title="OpenRouter">
      <HullActionSheetRow label="Reconnect" onPress={nothing} />
      <HullActionSheetCancel onPress={nothing} />
    </HullActionSheet></View>
  </View>;
}

const screens: Record<string, React.ReactNode> = {
  home: <Home />, homeconnected: <Home squireState="connected" />, homeoffline: <Home squireState="offline" />, search: <SearchResults />, key: <KeyService />,
  signin: <SignInService />, signinactions: <ConnectionActionsFrame />, squire: <SquireDetail />,
  wallet: <WalletDetail />, offlinekey: <OfflineKeyService />, offlinekeyactions: <OfflineKeyActionsFrame />,
};
createRoot(document.getElementById('root')!).render(screens[frame] ?? screens.home);

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    screen: { flex: 1, backgroundColor: hull.appCanvas },
    content: { paddingHorizontal: hull.space.lg, paddingTop: hull.layout.screenTop, paddingBottom: hull.space.xxl, gap: hull.layout.sectionGap },
    tallContent: { paddingBottom: hull.space.xxl },
    section: { gap: hull.space.xs },
    sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.appQuiet, marginBottom: hull.space.sm },
    search: { flexDirection: 'row', alignItems: 'center', minHeight: 48, backgroundColor: hull.appTile, borderColor: hull.appBorder, borderWidth: 1, borderRadius: 10, paddingHorizontal: hull.space.md, gap: hull.space.sm },
    searchIcon: { ...hull.type.hero, color: hull.appQuiet },
    searchInput: { ...Typography.ledger(), ...hull.type.body, color: hull.appInk, flex: 1 },
    placeholder: { color: hull.appQuiet },
    hero: { borderWidth: 1, borderColor: hull.appStrongBorder, backgroundColor: hull.appCard, borderRadius: 12, paddingHorizontal: hull.space.sm, paddingTop: hull.space.sm, paddingBottom: hull.space.md },
    heroMeta: { ...Typography.ledger(), ...hull.type.meta, color: hull.appQuiet, paddingHorizontal: hull.space.lg },
    squireMark: { width: 36, height: 36, backgroundColor: '#271B31', borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
    squireText: { ...Typography.mono(), ...hull.type.machine, color: hull.accent },
    searchRecommendation: { flexDirection: 'row', alignItems: 'center', gap: hull.space.md, minHeight: 88, borderWidth: 1, borderColor: hull.appStrongBorder, borderRadius: 12, backgroundColor: hull.appCard, paddingHorizontal: hull.space.md },
    fallbackCopy: { flex: 1, gap: hull.space.xs },
    fallbackTitle: { ...Typography.ledger(), ...hull.type.body, color: hull.appInk },
    fallbackDescription: { ...Typography.ledger(), ...hull.type.meta, color: hull.appQuiet },
    otherWays: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: hull.space.sm,
      borderBottomWidth: 1, borderBottomColor: hull.appBorder, paddingHorizontal: hull.space.sm },
    otherWaysLabel: { ...Typography.ledger(), ...hull.type.meta, color: hull.appInk, flex: 1 },
    otherWaysCount: { ...Typography.ledger(), ...hull.type.meta, color: hull.appQuiet },
    identity: { flexDirection: 'row', alignItems: 'center', gap: hull.space.sm },
    provenance: { ...Typography.ledger(), ...hull.type.body, color: hull.appQuiet },
    explainer: { ...Typography.ledger(), ...hull.type.body, color: hull.appSecondary, marginBottom: hull.space.sm },
    example: { borderLeftWidth: 2, borderLeftColor: hull.accent, paddingLeft: hull.space.md, paddingVertical: hull.space.sm },
    quote: { ...Typography.ledger(), ...hull.type.body, color: hull.appInk },
    sheetScene: { height: '100%', justifyContent: 'flex-end', backgroundColor: hull.appCanvas },
    dimmed: { ...StyleSheet.absoluteFillObject, opacity: 0.35 },
    sheetBottom: { width: '100%' },
    primary: { minHeight: 48, backgroundColor: hull.buttonPrimaryFill, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    primaryText: { ...Typography.ledger(), ...hull.type.bodyStrong, color: hull.buttonPrimaryText },
    note: { ...Typography.ledger(), ...hull.type.meta, color: hull.appQuiet, marginTop: hull.space.sm },
  };
});
