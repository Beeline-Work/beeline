export type NavigationScreen = 'AppShell' | 'Room' | 'AgentProfile'|'ScheduledWork'|'Tray';
export type NavigationRoute = Readonly<{ key?: string; name: string; params?: Readonly<object>;
  state?: NavigationState }>;
export type NavigationState = Readonly<{ index?: number; routes: readonly NavigationRoute[] }>;
export type NavigationResidency = Readonly<{ generation: number; key: string; screen: NavigationScreen; roomId?: string; workspaceId?: string; agentId?: string }>;

/** Navigation generations live here, outside React effects and renders.
 * Joining a committed state is idempotent; only a changed focused route creates
 * the next residency. StrictMode cleanup removes observers, never focus.
 */
export class NavigationOwner {
  private counter = 0;
  private focusedKey = '';
  private focused?: NavigationResidency;
  private foreground = true;
  private readonly listeners = new Set<() => void>();
  private state?: NavigationState;

  observe(state: NavigationState): void { this.state = state; this.reconcile(); }
  current(): NavigationResidency | undefined { return this.foreground ? this.focused : undefined; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  background(): void {
    if (!this.foreground) return;
    this.foreground = false; this.notify();
  }
  foregrounded(): void {
    if (this.foreground) return;
    this.foreground = true;
    // A foreground event resumes the committed navigation residency. It never
    // mints a fresh screen pass. Socket recovery or explicit Retry owns work.
    this.notify();
  }
  reset(): void { this.focused = undefined; this.focusedKey = ''; this.state = undefined; this.notify(); }
  private reconcile(): void {
    if (!this.foreground || !this.state) return;
    let state = this.state;
    let route: NavigationRoute | undefined;
    const path: string[] = [];
    const visited = new Set<NavigationState>();
    while (!visited.has(state)) {
      visited.add(state);
      route = state.routes[state.index ?? state.routes.length - 1];
      if (!route?.key) { this.focused = undefined; this.notify(); return; }
      path.push(route.key);
      if (!route.state) break;
      state = route.state;
    }
    const name = route?.name ?? '';
    const params = route?.params as Record<string, unknown> | undefined;
    const scheduled=['beeline/settings/schedules','beeline/settings/schedule','beeline/settings/subscription'].includes(name);
    const roomId = typeof params?.channelId === 'string' ? params.channelId : scheduled&&typeof params?.roomId==='string'?params.roomId:undefined;
    const agentId = typeof params?.agentId === 'string' ? params.agentId : undefined;
    const workspaceId = typeof params?.communityId === 'string' ? params.communityId : typeof params?.workspaceId === 'string' ? params.workspaceId : undefined;
    const screen = scheduled&&roomId?'ScheduledWork':name === 'beeline/tray'?'Tray':name === 'beeline/channels' ||
      name.startsWith('beeline/settings/') || name === 'beeline/members' ? 'AppShell' :
      name === 'beeline/chat/[channelId]' && roomId ? 'Room' : name === 'beeline/agent-profile' && agentId ? 'AgentProfile' : undefined;
    const key = JSON.stringify([path, screen, roomId, workspaceId, agentId]);
    if (key === this.focusedKey) return;
    this.focusedKey = key;
    this.focused = screen ? Object.freeze({ generation: ++this.counter, key, screen,
      ...(roomId ? { roomId: decodeURIComponent(roomId) } : {}), ...(workspaceId ? { workspaceId } : {}), ...(agentId ? { agentId } : {}) }) : undefined;
    this.notify();
  }
  private notify(): void { for (const listener of this.listeners) listener(); }
}
