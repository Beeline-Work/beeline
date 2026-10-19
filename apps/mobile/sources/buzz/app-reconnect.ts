import type { WorkbenchApp } from './workbench';
import { openAppSignIn } from './app-sign-in';
import { getWorkbenchSource } from './workbench-source';
import { readSharedWorkbench, type WorkbenchScope } from './workbench-surface';

/** The app needs Trusty Squire connected before its own reconnect can run. */
export function appNeedsSquire(app: WorkbenchApp) {
  return app.transport.startsWith('squire-') && app.errorMessage === 'Connect Trusty Squire in Connectors first';
}
/**
 * Reconnects one app: provider sign-in for Composio apps, otherwise the app's
 * own computer retries it. Returns a notice when the computer continues in chat.
 */
export async function reconnectWorkbenchApp(app: WorkbenchApp, scope: WorkbenchScope): Promise<string | null> {
  const source = getWorkbenchSource();
  if (app.transport === 'composio') {
    const started = await source.beginAppSignIn({ appId: app.id });
    await openAppSignIn(started.authorizationUrl, { ...scope, appId: app.id });
    return null;
  }
  const helpers = await source.listHelpers({ workspaceId: scope.workspaceId });
  const helper = helpers.find(item => item.online && (!app.helperId || item.id === app.helperId));
  if (!helper) throw new Error(app.helperName
    ? `Bring ${app.helperName} online, then retry ${app.name}.`
    : `Connect a helper in Connectors, then retry ${app.name}.`);
  const started = await source.connectApp({ workspaceId: scope.workspaceId, app: app.name, helperId: helper.id,
    ...(app.status === 'error' ? { reconnect: true } : {}) });
  if (started.authorizationUrl) {
    await openAppSignIn(started.authorizationUrl, { ...scope, appId: started.appId });
    return null;
  }
  const updatedView = await readSharedWorkbench(scope, { refresh: true });
  const updated = updatedView.apps.find(item => item.id === started.appId);
  return updated?.status === 'connecting' ? `Continue connecting ${app.name} in your chat with ${helper.name}.` : null;
}
