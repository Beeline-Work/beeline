import { useState } from 'react';
import { Platform } from 'react-native';
import { router, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import type { CompanySuggestion, CompanyItem, WorkbenchCompany } from '@beeline/api-contract/workbench';
import type { WorkbenchApp } from './workbench';
import { authSessionOptions } from '@/auth/auth-session';
import { openAppSignIn } from './app-sign-in';
import { appErrorCopy } from './app-error-copy';
import { getWorkbenchSource } from './workbench-source';
import { readSharedWorkbench, type WorkbenchScope } from './workbench-surface';
import { getWalletSource } from './wallet-source';
import { publishSharedWallet } from './wallet-surface';
import { resolveWalletWorkspaceId } from './wallet-workspace';
import { useActiveCommunityId } from './use-active-community';

export function openCompanyItem(target: CompanyItem['target'], scope: WorkbenchScope) {
  const route = target.kind === 'key' ? { pathname: '/beeline/settings/workbench/connection', params: { ...scope, connectionId: target.connectionId } }
    : target.kind === 'app' ? { pathname: '/beeline/settings/workbench/app', params: { ...scope, appId: target.appId } }
      : target.kind === 'wallet' ? { pathname: '/beeline/settings/workbench/wallet', params: { ...scope } }
        : target.kind === 'connector' ? { pathname: '/beeline/settings/workbench/connect', params: { ...scope, connectorId: target.connectorId } }
          : undefined;
  if (route) router.push(route as Href);
}
export type ConnectorDestination =
  | { readonly kind: 'info' }
  | { readonly kind: 'item'; readonly target: CompanyItem['target'] }
  | { readonly kind: 'app-sign-in'; readonly appId: string };
/**
 * One tap per Connectors row. A connected frontend opens directly; a failed
 * connection starts its own reconnect; everything else opens the info page,
 * which shows the computers that can retry or the error that cannot be retried.
 */
export function connectorDestination(row: WorkbenchCompany, apps: readonly WorkbenchApp[] = []): ConnectorDestination {
  if (row.kind === 'sign-in-service') return { kind: 'info' };
  const broken = row.items.find(item => item.attention);
  if (broken) {
    const target = broken.target;
    if (target.kind === 'connector' || target.kind === 'wallet') return { kind: 'item', target };
    if (target.kind === 'app') return apps.find(app => app.id === target.appId)?.transport === 'composio'
      ? { kind: 'app-sign-in', appId: target.appId } : { kind: 'item', target };
    return { kind: 'info' };
  }
  const wallet = row.items.find(item => item.target.kind === 'wallet');
  return wallet ? { kind: 'item', target: wallet.target } : { kind: 'info' };
}
/** Reuses the existing connection ceremonies; grouping never grants or changes access. */
export function useConnectCompanyApp(scope: WorkbenchScope) {
  const activeWorkspaceId = useActiveCommunityId();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connect = async (app: CompanySuggestion) => {
    if (busy) return;
    setBusy(app.appKey); setError(null);
    try {
      if (app.flow === 'squire' || app.flow === 'tailscale') {
        router.push({ pathname: '/beeline/settings/workbench/connect', params: { ...scope, connectorId: app.flow === 'squire' ? 'trusty-squire' : 'tailscale' } } as Href);
        return;
      }
      if (app.flow === 'link') {
        const { authorizationUrl } = await getWorkbenchSource().beginLinkSignIn();
        const state = new URL(authorizationUrl).searchParams.get('state') ?? undefined;
        const returnUri = 'beeline://beeline/settings/workbench';
        const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, returnUri, authSessionOptions(Platform.OS, returnUri));
        if (result.type !== 'success') await getWorkbenchSource().cancelLinkSignIn(state);
      } else if (app.flow === 'wallet') {
        const workspaceId = await resolveWalletWorkspaceId(scope.workspaceId, activeWorkspaceId);
        if (!workspaceId) throw new Error('Join or select a Workspace, then open Wallet again.');
        const wallet = await getWalletSource().createWallet({ workspaceId });
        const grant = await getWalletSource().grantDelegation({ workspaceId });
        await publishSharedWallet(workspaceId, { ...wallet, delegation: { active: true, expiresAt: grant.expiresAt } });
        router.push({ pathname: '/beeline/settings/workbench/wallet', params: { workspaceId } } as Href);
      } else {
        const helpers = await getWorkbenchSource().listHelpers({ workspaceId: scope.workspaceId });
        const helper = helpers.find(item => item.online);
        if (!helper) throw new Error('Connect a computer to use this app');
        const started = await getWorkbenchSource().connectApp({ workspaceId: scope.workspaceId, app: app.appName, helperId: helper.id, registryServerName: app.preferredRoute ? undefined : app.registryServerName, registryVersion: app.preferredRoute ? undefined : app.registryVersion, preferredRoute: app.preferredRoute });
        if (started.authorizationUrl) await openAppSignIn(started.authorizationUrl, { ...scope, appId: started.appId });
      }
      await readSharedWorkbench(scope, { refresh: true });
    } catch (cause) { setError(appErrorCopy(cause instanceof Error ? cause.message : 'Connecting failed')); }
    finally { setBusy(null); }
  };
  const open = async (row: WorkbenchCompany, apps?: readonly WorkbenchApp[]) => {
    const destination = connectorDestination(row, apps);
    if (destination.kind === 'item') { openCompanyItem(destination.target, scope); return; }
    if (destination.kind === 'info') {
      router.push({ pathname: '/beeline/settings/workbench/service', params: { ...scope, service: row.id } } as Href);
      return;
    }
    if (busy) return;
    setBusy(row.id); setError(null);
    try {
      const started = await getWorkbenchSource().beginAppSignIn({ appId: destination.appId });
      await openAppSignIn(started.authorizationUrl, { ...scope, appId: destination.appId });
      await readSharedWorkbench(scope, { refresh: true });
    } catch (cause) { setError(appErrorCopy(cause instanceof Error ? cause.message : 'Reconnecting failed')); }
    finally { setBusy(null); }
  };
  return { connect, open, busy, error };
}
