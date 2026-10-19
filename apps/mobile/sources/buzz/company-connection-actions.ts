import { useState } from 'react';
import { Platform } from 'react-native';
import { router, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import type { CompanySuggestion, CompanyItem } from '@beeline/api-contract/workbench';
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
      : target.kind === 'wallet' ? { pathname: '/beeline/settings/workbench/wallet-service', params: { workspaceId: scope.workspaceId } }
        : target.kind === 'connector' ? { pathname: '/beeline/settings/workbench/connect', params: { ...scope, connectorId: target.connectorId } }
          : undefined;
  if (route) router.push(route as Href);
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
        else openCompanyItem({ kind: 'app', appId: started.appId }, scope);
      }
      await readSharedWorkbench(scope, { refresh: true });
    } catch (cause) { setError(appErrorCopy(cause instanceof Error ? cause.message : 'Connecting failed')); }
    finally { setBusy(null); }
  };
  return { connect, busy, error };
}
