import { subscribeClientReset } from '@/sync/client-reset';

/** UI-only lane fixture. Tests provide server DTOs here; transport, authority,
 * ordering and durable persistence are exercised by the real owner suites. */
export function canonicalRouterFixture(load: (input: any) => Promise<unknown>) {
  type View = {
    state: 'ABSENT' | 'OPENING' | 'LIVE' | 'PARKED';
    value: any;
    cut: null;
    error: string | null;
  };
  const empty: View = { state: 'ABSENT', value: null, cut: null, error: null };
  const values = new Map<string, View>(),
    listeners = new Set<() => void>();
  let generation = 0;
  const key = (input: unknown) => JSON.stringify(input);
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const publish = (input: unknown, value: unknown) => {
    values.set(key(input), { state: 'LIVE', value, cut: null, error: null });
    notify();
  };
  function demand(input: unknown) {
    values.set(key(input), { state: 'OPENING', value: null, cut: null, error: null });
    const captured = generation;
    void load(input).then(
      (value) => {
        if (captured === generation) publish(input, value);
      },
      (error) => {
        if (captured !== generation) return;
        values.set(key(input), { state: 'PARKED', value: null, cut: null, error: String(error) });
        notify();
      },
    );
  }
  const reset = () => {
    generation++;
    values.clear();
    notify();
  };
  subscribeClientReset(reset);
  const noop = () => {};
  const current = (input: unknown) => values.get(key(input)) ?? empty;
  return {
    observerCount: () => listeners.size,
    async pushServer(input: unknown) {
      publish(input, await load(input));
    },
    reset,
    resetFixture() {
      generation++;
      values.clear();
      listeners.clear();
    },
    publish,
    park(input: unknown, error: string, retain = false) {
      values.set(key(input), {
        state: 'PARKED',
        value: retain ? current(input).value : null,
        cut: null,
        error,
      });
      notify();
    },
    routerFamilyMode: () => 'router' as const,
    subscribeRouterOwner: subscribe,
    routerLaneSnapshot: current,
    acquireRouterLane(input: unknown, _visible: () => boolean, listener: () => void) {
      const release = subscribe(listener);
      if (!values.has(key(input))) demand(input);
      return { current: () => current(input), release, subscribe, refreshVisibility: noop };
    },
    retryRouterLane: demand,
    routerOwnerListPanel: noop,
    routerOwnerUsageProfile: noop,
    routerOwnerArtifactAction: noop,
    routerOwnerArtifactViewport: noop,
    routerOwnerNavigation: noop,
    routerOwnerDisconnected: noop,
  };
}
