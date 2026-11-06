import { IndexRow } from '@/components/buzz/IndexRow';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { InlineRow } from '@/components/buzz/IndexRow';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { PageHeader } from '@/components/buzz/PageHeader';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { Button } from '@/components/buzz/Button';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel } from '@/components/buzz/HullActionSheet';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { connectionViewState, openCompanyItem, useConnectCompanyApp } from '@/buzz/company-connection-actions';
import { appNeedsSquire, reconnectWorkbenchApp } from '@/buzz/app-reconnect';
import { appErrorCopy } from '@/buzz/app-error-copy';
import type { WorkbenchApp } from '@/buzz/workbench';
import type { AiClientConnection, WorkbenchCompany } from '@beeline/api-contract/workbench';

function param(v: string | string[] | undefined) { return Array.isArray(v) ? v[0] : v; }
/** Trusty Squire keeps the keys; it has no disconnect, so the page links out to its vault. */
export const SQUIRE_VAULT_URL = 'https://trustysquire.ai/vault';
type Machine = WorkbenchCompany['machines'][number];
const needsFix = (m: Machine) => m.status !== 'connected' || Boolean(m.error);
/** "Oct 31", or "today" for the current local day. */
export function aiClientDay(seconds: number, now = new Date()): string {
  const day = new Date(seconds * 1000);
  return day.toDateString() === now.toDateString() ? 'today'
    : day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
const aiClientDates = (client: AiClientConnection) =>
  `Connected ${aiClientDay(client.connectedAt)} · last used ${client.lastUsedAt ? aiClientDay(client.lastUsedAt) : 'not yet'}.`;
const aiClientNote = (client: AiClientConnection) => client.agent
  ? `${client.agent.name} uses ${client.name} to read your Rooms and post. It posts as ${client.agent.name}, not as you.`
  : `${client.name} reads your Rooms and posts as its own agent, not as you.`;
/** Signed in means a settled Google session; anything else needs sign-in (mock v3). */
const signedIn = (m: Machine) => m.status === 'connected' && !m.reconnecting && !m.error;
const signedInLine = (m: Machine) => m.signedInAs ? `Signed in as ${m.signedInAs}` : 'Signed in';
export default function ConnectorServiceScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[]; viewerId?: string | string[]; helperId?: string | string[]; service?: string | string[] }>();
  const scope = { workspaceId: param(params.workspaceId) ?? '', viewerId: param(params.viewerId) ?? '' };
  const service = param(params.service) ?? '';
  const { value: view, error: loadError, refresh } = useSharedWorkbench(scope);
  const row = view?.companies?.rows.find(item => item.id === service || (service === 'trusty-squire' && item.kind === 'sign-in-service'));
  const insets = useSafeAreaInsets();
  const desktopPageLayout = useDesktopPageLayout();
  const { theme } = useUnistyles();
  const actions = useConnectCompanyApp(scope);
  const [machine, setMachine] = useState<Machine | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [appOpen, setAppOpen] = useState<WorkbenchApp | null>(null);
  const [appBusy, setAppBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A connected AI app has its own Status sheet: the same sheet as an app connection.
  const aiClient = row?.roomsClientId ? view?.aiClients?.find(client => client.clientId === row.roomsClientId) : undefined;
  const [aiOpen, setAiOpen] = useState(false);
  const manageMachine = row?.machines.find(item => item.id === machine?.id) ?? machine;
  const reconnectMachine = (helperId: string) => {
    setMachine(null); router.push({ pathname: '/beeline/settings/workbench/connect', params: { ...scope, connectorId: 'trusty-squire', helperId } } as Href);
  };

  const topState = row ? connectionViewState(row) : undefined;
  const needSignIn = row?.machines.filter(item => !signedIn(item)).length ?? 0;
  const keyed = row?.items.some(item => item.target.kind === 'key') ?? false;
  const agents = row?.kind === 'sign-in-service' ? 'Trusty Squire signs up and signs in to websites for your agents. Your computers keep the sign-in sessions.'
    : row?.items.some(item => item.kind === 'connection') ? `Agents use ${row.name} when you ask them to.`
      : `Agents call ${row?.name ?? 'this service'} with your keys, only on the hosts you allow.`;
  // App connections act here, so the info page is the only page between Connectors and the action.
  const reconnectApp = async (app: WorkbenchApp) => {
    setAppOpen(null);
    if (appNeedsSquire(app)) { router.push({ pathname: '/beeline/settings/workbench/connect', params: { ...scope, connectorId: 'trusty-squire' } } as Href); return; }
    if (appBusy) return;
    setAppBusy(app.id); setError(null); setNotice(null);
    try { setNotice(await reconnectWorkbenchApp(app, scope)); await refresh(); }
    catch (cause) { setError(appErrorCopy(cause, 'Could not connect app')); }
    finally { setAppBusy(null); }
  };
  const disconnectApp = async (app: WorkbenchApp) => {
    setAppOpen(null);
    if (appBusy) return;
    setAppBusy(app.id); setError(null);
    try { await getWorkbenchSource().disconnectApp({ workspaceId: scope.workspaceId, appId: app.id }); await refresh(); }
    catch (cause) { setError(appErrorCopy(cause, 'Could not disconnect app')); }
    finally { setAppBusy(null); }
  };
  const appRow = (item: WorkbenchCompany['items'][number], app: WorkbenchApp) => {
    const state = connectionViewState(item);
    const computer = app.transport === 'composio' ? null : appNeedsSquire(app) ? 'Trusty Squire' : app.helperName ?? 'Your computer';
    const busy = appBusy === app.id || app.status === 'connecting';
    const reason = item.status ?? (app.errorMessage ? appErrorCopy(app.errorMessage) : undefined);
    if (state === 'connected') {
      return <SettingsRow appBoard key={item.id} title={item.title} description={item.subtitle} chevron="right"
        disabled={busy} onPress={() => setAppOpen(app)} testID={`company-item-${item.id}`} />;
    }
    if (state === 'error') {
      return <SettingsRow appBoard key={item.id} title={item.title} description={item.subtitle}
        value={busy ? 'Connecting…' : reason} valueTone="danger" disabled={busy}
        action="Reconnect" onPress={() => void reconnectApp(app)} testID={`company-item-${item.id}`} />;
    }
    return <SettingsRow appBoard key={item.id} title={item.title} description={[computer, item.subtitle].filter(Boolean).join(' · ')}
      action={busy ? undefined : 'Connect'} value={busy ? 'Connecting…' : undefined} disabled={busy}
      onPress={() => void reconnectApp(app)} testID={`company-item-${item.id}`} />;
  };
  // Connect reuses each item's existing path: app reconnect, or its connector/wallet page.
  const connectItem = (item: WorkbenchCompany['items'][number]) => {
    const target = item.target;
    const app = target.kind === 'app' ? view?.apps.find(entry => entry.id === target.appId) : undefined;
    if (app) void reconnectApp(app);
    else if (target.kind === 'link') setLinkOpen(true);
    else openCompanyItem(target, scope);
  };
  const connectTop = () => {
    if (!row) return;
    if (row.kind === 'sign-in-service') {
      const fix = row.machines.find(item => item.online && !item.reconnecting && needsFix(item));
      router.push({ pathname: '/beeline/settings/workbench/connect', params: { ...scope, connectorId: 'trusty-squire', ...(fix ? { helperId: fix.id } : {}) } } as Href);
      return;
    }
    const item = row.items.find(entry => connectionViewState(entry) === 'connect');
    if (item) connectItem(item);
  };
  const disconnect = async () => {
    try {
      if (manageMachine) await getWorkbenchSource().disconnectConnector({ workspaceId: scope.workspaceId, connectorId: `squire:${manageMachine.id}` });
      else await getWorkbenchSource().disconnectLinkSignIn();
      setMachine(null); setLinkOpen(false); await refresh();
    } catch { setError('Could not disconnect. Try again.'); }
  };
  const disconnectAiClient = async () => {
    if (!aiClient || appBusy) return;
    setAppBusy(aiClient.clientId); setError(null);
    try {
      await getWorkbenchSource().disconnectAiClient({ clientId: aiClient.clientId });
      setAiOpen(false); await refresh(); router.back();
    } catch { setAiOpen(false); setError('Could not disconnect. Try again.'); }
    finally { setAppBusy(null); }
  };
  const agent = aiClient?.agent;
  return <View style={[styles.screen, desktopPageLayout && { width: '100%', maxWidth: desktopColumnWidths.detail, alignSelf: 'center' }, { paddingTop: insets.top }]} testID="connector-service-screen">
    <PageHeader eyebrow="Connectors" prominent title={row?.name ?? 'Connectors'} backAccessibilityLabel="Back to Connectors" onBack={() => router.back()} />
    {loadError && !row ? <View style={styles.failureInset}><IndexRow inset="flush" title="Network is not available right now." action="Retry" onPress={() => void refresh()}  /></View> : !view ? <SurfaceGlyphLoader /> : !row ?
      <Text style={styles.note}>This company is no longer connected.</Text> :
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + theme.buzz.space.xl }]}>
        {row.roomsClientId ? <>
          <SettingsRow appBoard title={row.name} description={row.domain} leading={<ServiceMark company={row.name} domain={row.domain} mark={row.logo} />}
            value="Connected" statusGlyph="live" chevron="right" disabled={Boolean(appBusy)} onPress={() => setAiOpen(true)} testID="connector-info-status" />
          {aiClient ? <Text style={styles.note} testID="connector-info-agents">{aiClientNote(aiClient)}</Text> : null}
          {agent ? <View>
            <RoomListSectionHeader title="Agent" inset="content" spacing="flush" />
            <SettingsRow appBoard title={agent.name} description={agent.handle ? `@${agent.handle}` : undefined}
              leading={<IdentityMark kind="agent" seed={agent.id} avatarUrl={agent.avatar} name={agent.name} size={36} />} chevron="right"
              onPress={() => router.push({ pathname: '/beeline/agent-profile', params: { communityId: scope.workspaceId, agentId: agent.id } } as Href)}
              testID="ai-client-agent" />
          </View> : null}
          {aiClient ? <View>
            <RoomListSectionHeader title="What it can do" inset="content" spacing="flush" />
            {aiClient.scopes.includes('rooms:read') ? <SettingsRow appBoard title="Read messages in your Rooms" testID="ai-client-can-read" /> : null}
            {aiClient.scopes.includes('rooms:write') ? <SettingsRow appBoard title={`Post and reply as ${agent?.name ?? 'its agent'}`} testID="ai-client-can-post" /> : null}
          </View> : null}
          {aiClient ? <Text style={styles.note} testID="ai-client-dates">{aiClientDates(aiClient)}</Text> : null}
          {error ? <SettingsRow title={error} /> : null}
        </> : <>{row.kind === 'sign-in-service' ? <SettingsRow appBoard title={row.name} description={row.domain}
          leading={<ServiceMark company={row.name} domain={row.domain} mark={row.logo} />}
          value={needSignIn ? `${needSignIn} need sign-in` : 'Signed in'} valueTone={needSignIn ? 'danger' : undefined}
          statusGlyph={needSignIn ? 'failed' : 'live'} testID="connector-info-status" />
          : <SettingsRow appBoard title={row.name} description={[row.domain, row.subtitle].filter(Boolean).join(' · ')} leading={<ServiceMark company={row.name} domain={row.domain} mark={row.logo} />}
          value={topState === 'error' ? row.status ?? 'Needs attention' : topState === 'connect' ? undefined : 'Connected'}
          action={topState === 'connect' ? 'Connect' : undefined} onPress={topState === 'connect' ? connectTop : undefined}
          valueTone={topState === 'error' ? 'danger' : undefined}
          statusGlyph={topState === 'error' ? 'failed' : topState === 'connected' ? 'live' : undefined} testID="connector-info-status" />}
        <Text style={styles.note} testID="connector-info-agents">{agents}</Text>
        {row.attention && row.kind !== 'sign-in-service' ? <SettingsRow title={row.attention} /> : null}
        {row.kind === 'sign-in-service' ? <View>
          <InlineRow style={styles.sectionLine} testID="squire-computers-head">
            <Text accessibilityRole="header" style={styles.section}>YOUR COMPUTERS</Text>
            <Text style={[styles.section, styles.sectionCount]}>{row.machines.length}</Text>
          </InlineRow>
          {row.machines.map(item => signedIn(item)
            // A signed-in computer opens its own sheet; every other one connects in one tap.
            ? <SettingsRow appBoard key={item.id} title={item.name} description={item.statusText ?? signedInLine(item)}
              descriptionContent={<InlineRow style={styles.signedIn}><View style={styles.signedInDot} testID={`squire-computer-${item.id}-dot`} />
                <Text style={styles.signedInText}>{item.statusText && item.statusText !== 'Google signed in' && !item.signedInAs ? item.statusText : signedInLine(item)}</Text></InlineRow>}
              chevron="right" onPress={() => setMachine(item)} testID={`squire-computer-${item.id}`} />
            : <SettingsRow appBoard key={item.id} title={item.name} description="Google sign-in needed"
              action="Connect" onPress={() => reconnectMachine(item.id)} testID={`squire-computer-${item.id}`} />)}
        </View> : (['connection', 'login', 'key'] as const).map(kind => {
          const items = row.items.filter(item => item.kind === kind);
          return items.length || kind === 'connection' && row.mcp ? <View key={kind}>
            <RoomListSectionHeader title={kind === 'connection' ? 'Connections' : kind === 'login' ? 'Logins' : 'Keys'} inset="content" spacing="flush" />
            {kind === 'connection' && row.mcp ? <SettingsRow appBoard title={row.mcp.name} description={`Sign in with ${row.name.replace(/\.[a-z]+$/i, '')} MCP`}
              chevron="right" disabled={Boolean(actions.busy)} onPress={() => void actions.connect(row.mcp!)} testID="company-mcp-connect" /> : null}
            {items.map(item => {
              const target = item.target;
              const app = target.kind === 'app' ? view.apps.find(entry => entry.id === target.appId) : undefined;
              return app ? appRow(item, app) : item.target.kind === 'key'
              ? <SettingsRow appBoard key={item.id} title={item.title} description={item.subtitle}
                value={item.status} valueTone={item.attention ? 'danger' : undefined} testID={`company-item-${item.id}`} />
              : connectionViewState(item) === 'connect'
              ? <SettingsRow appBoard key={item.id} title={item.title} description={item.subtitle}
                action="Connect" onPress={() => connectItem(item)} testID={`company-item-${item.id}`} />
              : <SettingsRow appBoard key={item.id} title={item.title} description={item.subtitle}
                value={item.status} valueTone={item.attention ? 'danger' : undefined} chevron="right"
                onPress={() => item.target.kind === 'link' ? setLinkOpen(true) : openCompanyItem(item.target, scope)} testID={`company-item-${item.id}`} />;
            })}
          </View> : null;
        })}
        {keyed ? <Button label="Manage in Trusty Squire" variant="secondary" fullWidth
          onPress={() => void WebBrowser.openBrowserAsync(SQUIRE_VAULT_URL)} testID="connector-squire-vault" /> : null}
        {row.alsoAvailable.length ? <View><RoomListSectionHeader title="Also available" inset="content" spacing="flush" />
          {row.alsoAvailable.map(app => <SettingsRow appBoard key={app.appKey} title={app.name} description={app.purpose}
            leading={<ServiceMark company={app.providerName} domain={app.domain} mark={app.logo} />} chevron="right"
            disabled={Boolean(actions.busy)} onPress={() => void actions.connect(app)} testID={`company-available-${app.appKey}`} />)}
        </View> : null}
        {loadError ? <SettingsRow title="Could not refresh connections. Try again." /> : null}
        {notice ? <Text accessibilityLiveRegion="polite" style={styles.note} testID="connector-info-notice">{notice}</Text> : null}
        {error || actions.error ? <SettingsRow title={(error ?? actions.error)!} /> : null}
        </>}
      </ScrollView>}
    <HullActionSheetModal visible={Boolean(machine) || linkOpen} title={machine?.name ?? 'Link'} onClose={() => { setMachine(null); setLinkOpen(false); }}>
      {machine && manageMachine && !signedIn(manageMachine) ? <HullActionSheetRow label="Connect" onPress={() => reconnectMachine(machine.id)} />
        : <HullActionSheetRow label="Disconnect" destructive onPress={() => void disconnect()} />}
      <HullActionSheetCancel onPress={() => { setMachine(null); setLinkOpen(false); }} />
    </HullActionSheetModal>
    {/* One connection sheet: an app connection's row and an AI app's Status row open it alike. */}
    <HullActionSheetModal visible={Boolean(appOpen) || aiOpen} title={appOpen?.name ?? row?.name} onClose={() => { setAppOpen(null); setAiOpen(false); }}>
      {appOpen ? <HullActionSheetRow label="Disconnect" destructive onPress={() => void disconnectApp(appOpen)} />
        : aiOpen ? <HullActionSheetRow label="Disconnect" destructive disabled={Boolean(appBusy)} onPress={() => void disconnectAiClient()} testID="ai-client-disconnect" /> : null}
      <HullActionSheetCancel onPress={() => { setAppOpen(null); setAiOpen(false); }} />
    </HullActionSheetModal>
  </View>;
}
const styles = StyleSheet.create(theme => ({
    failureInset: { paddingHorizontal: theme.buzz.roomList.edge },
  screen: { flex: 1, backgroundColor: theme.buzz.appCanvas },
  content: { paddingHorizontal: theme.buzz.space.lg, paddingTop: theme.buzz.layout.screenTop, gap: theme.buzz.layout.sectionGap },
  note: { ...theme.buzz.type.meta, color: theme.buzz.appQuiet },
  section: { ...theme.buzz.squireConnect.sectionType, textTransform: 'uppercase', color: theme.buzz.textMuted, marginBottom: theme.buzz.space.xs },
  sectionCount: { color: theme.buzz.textDisabled },
  sectionLine: { gap: theme.buzz.squireConnect.dotGap },
  signedIn: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.squireConnect.dotGap },
  signedInDot: { width: 7, height: 7, borderRadius: 7 / 2, backgroundColor: theme.buzz.diffAdded },
  signedInText: { ...theme.buzz.type.meta, color: theme.buzz.appQuiet, flexShrink: 1 },
}));
