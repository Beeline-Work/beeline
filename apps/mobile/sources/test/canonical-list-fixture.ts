/** UI tests supply complete server-authored DTOs at the router boundary.
 * Actual owner tests cover admission, transport, replay and storage. This fixture
 * never translates legacy events or reduces list rows.
 */
export function canonicalListFixture(load: (workspaceId: string) => Promise<unknown>) {
  type View = {
    state: 'ABSENT' | 'OPENING' | 'LIVE' | 'PARKED';
    value: unknown;
    cut: null;
    error: string | null;
  };
  type Request = { family: string; workspaceId?: string };
  const absent: View = { state: 'ABSENT', value: null, cut: null, error: null };
  const rows = new Map<string, View>();
  const listeners = new Set<() => void>();
  let generation = 0;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const current = (request: Request) =>
    request.family === 'room-list' ? (rows.get(request.workspaceId ?? '') ?? absent) : absent;
  function publish(workspace: string, value: unknown) {
    rows.set(workspace, { state: 'LIVE', value, cut: null, error: null });
    notify();
  }
  function demand(workspace: string) {
    if (rows.has(workspace)) return;
    rows.set(workspace, { state: 'OPENING', value: null, cut: null, error: null });
    const admitted = generation;
    void load(workspace).then(
      (value) => {
        if (admitted === generation) publish(workspace, value);
      },
      (error) => {
        if (admitted !== generation) return;
        rows.set(workspace, { state: 'PARKED', value: null, cut: null, error: String(error) });
        notify();
      },
    );
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    publish,
    reset() {
      generation++;
      rows.clear();
      notify();
    },
    routerFamilyMode: () => 'router' as const,
    routerLaneSnapshot: current,
    subscribeRouterOwner: subscribe,
    acquireRouterLane(request: Request, visible: () => boolean, listener: () => void) {
      const refreshVisibility = () => {
        if (request.family === 'room-list' && visible()) demand(request.workspaceId ?? '');
      };
      const release = subscribe(listener);
      refreshVisibility();
      return { current: () => current(request), release, subscribe, refreshVisibility };
    },
  };
}
