import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { PageHeader } from '@/components/buzz/PageHeader';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { Button } from '@/components/buzz/Button';
import { NetworkUnavailableState } from '@/components/buzz/NetworkUnavailableState';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel } from '@/components/buzz/HullActionSheet';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { connectionViewState, openCompanyItem, useConnectCompanyApp } from '@/buzz/company-connection-actions';
import { appNeedsSquire, reconnectWorkbenchApp } from '@/buzz/app-reconnect';
import { appErrorCopy } from '@/buzz/app-error-copy';
import type { WorkbenchApp } from '@/buzz/workbench';
import type { WorkbenchCompany } from '@beeline/api-contract/workbench';

function param(v: string | string[] | undefined) { return Array.isArray(v) ? v[0] : v; }
/** Trusty Squire keeps the keys; it has no disconnect, so the page links out to its vault. */
export const SQUIRE_VAULT_URL = 'https://trustysquire.ai/vault';
type Machine = WorkbenchCompany['machines'][number];
const needsFix = (m: Machine) => m.status !== 'connected' || Boolean(m.error);
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
  const manageMachine = row?.machines.find(item => item.id === machine?.id) ?? machine;
  const reconnectMachine = (helperId: string) => {
    setMachine(null); router.push({ pathname: '/beeline/settings/workbench/connect', params: { ...scope, connectorId: 'trusty-squire', helperId } } as Href);
  };
  // Reopen the pairing already waiting on sign-in; pairing again would replace its page.
  const continueMachine = (helperId: string) => {
    setMachine(null); router.push({ pathname: '/beeline/settings/workbench/connect', params: { ...scope, connectorId: 'trusty-squire', pairedConnectorId: `squire:${helperId}` } } as Href);
  };
  const topState = row ? connectionViewState(row) : undefined;
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
  return <View style={[styles.screen, desktopPageLayout && { width: '100%', maxWidth: desktopColumnWidths.detail, alignSelf: 'center' }, { paddingTop: insets.top }]} testID="connector-service-screen">
    <PageHeader eyebrow="Connectors" prominent title={row?.name ?? 'Connectors'} backAccessibilityLabel="Back to Connectors" onBack={() => router.back()} />
    {loadError && !row ? <NetworkUnavailableState onRetry={() => void refresh()} /> : !view ? <SurfaceGlyphLoader /> : !row ?
      <Text style={styles.note}>This company is no longer connected.</Text> :
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + theme.buzz.space.xl }]}>
        <SettingsRow appBoard title={row.name} description={row.kind === 'sign-in-service' ? row.subtitle : [row.domain, row.subtitle].filter(Boolean).join(' · ')} leading={<ServiceMark company={row.name} domain={row.domain} mark={row.logo} />}
          value={topState === 'error' ? row.status ?? 'Needs attention'
            : topState === 'connect' ? undefined
              : row.kind === 'sign-in-service' ? row.status : 'Connected'}
          action={topState === 'connect' ? 'Connect' : undefined} onPress={topState === 'connect' ? connectTop : undefined}
          valueTone={topState === 'error' ? 'danger' : undefined}
          statusGlyph={topState === 'error' ? 'failed' : topState === 'connected' && !row.machines.some(item => item.reconnecting) ? 'live' : undefined} testID="connector-info-status" />
        <Text style={styles.note} testID="connector-info-agents">{agents}</Text>
        {row.attention ? <SettingsRow title={row.attention} /> : null}
        {row.kind === 'sign-in-service' ? <View>
          <RoomListSectionHeader title="Your computers" inset="content" />
          {row.machines.map(item => {
            const status = item.statusText ?? (item.reconnecting ? 'Waiting for sign-in' : item.signedInAs ?? (item.status === 'error' ? 'Google sign-in expired' : item.status === 'connected' ? 'Google signed in' : 'Google sign-in needed'));
            // A pairing waiting on the person reopens its sign-in in one tap.
            if (item.reconnecting && item.online)
              return <SettingsRow appBoard key={item.id} title={item.name} description={status}
                action="Continue" onPress={() => continueMachine(item.id)} testID={`squire-computer-${item.id}`} />;
            // An online computer that can retry does it in one tap; an offline one shows why it cannot.
            return !item.reconnecting && item.online && needsFix(item)
              ? <SettingsRow appBoard key={item.id} title={item.name} description={[status, item.error].filter(Boolean).join(' · ')} descriptionTone={item.status === 'error' ? 'danger' : undefined}
                action={item.status === 'not-added' ? 'Set up' : 'Connect'} onPress={() => reconnectMachine(item.id)} testID={`squire-computer-${item.id}`} />
              : <SettingsRow appBoard key={item.id} title={item.name} description={item.error} value={status}
                valueTone={item.status === 'error' || (item.status === 'connected' && !item.online) ? 'danger' : undefined}
                chevron="right" disabled={item.reconnecting} onPress={() => setMachine(item)} testID={`squire-computer-${item.id}`} />;
          })}
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
      </ScrollView>}
    <HullActionSheetModal visible={Boolean(machine) || linkOpen} title={machine?.name ?? 'Link'} onClose={() => { setMachine(null); setLinkOpen(false); }}>
      {manageMachine?.reconnecting ? <HullActionSheetRow label="Continue sign-in" onPress={() => continueMachine(manageMachine.id)} /> : manageMachine && !manageMachine.online ? <Text style={styles.error} testID="squire-computer-offline">{manageMachine.error ?? `Turn on ${manageMachine.name} to reconnect it.`}</Text>
        : machine && manageMachine && needsFix(manageMachine) ? <HullActionSheetRow label={manageMachine.status === 'not-added' ? 'Set up' : 'Connect'} onPress={() => reconnectMachine(machine.id)} /> : <HullActionSheetRow label="Disconnect" destructive onPress={() => void disconnect()} />}
      <HullActionSheetCancel onPress={() => { setMachine(null); setLinkOpen(false); }} />
    </HullActionSheetModal>
    <HullActionSheetModal visible={Boolean(appOpen)} title={appOpen?.name} onClose={() => setAppOpen(null)}>
      {appOpen ? <HullActionSheetRow label="Disconnect" destructive onPress={() => void disconnectApp(appOpen)} /> : null}
      <HullActionSheetCancel onPress={() => setAppOpen(null)} />
    </HullActionSheetModal>
  </View>;
}
const styles = StyleSheet.create(theme => ({
  screen: { flex: 1, backgroundColor: theme.buzz.appCanvas },
  content: { paddingHorizontal: theme.buzz.space.lg, paddingTop: theme.buzz.layout.screenTop, gap: theme.buzz.layout.sectionGap },
  note: { ...theme.buzz.type.meta, color: theme.buzz.appQuiet }, error: { ...theme.buzz.type.meta, color: theme.buzz.dialogDanger },
}));
