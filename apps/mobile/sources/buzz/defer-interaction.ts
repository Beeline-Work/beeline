import { InteractionManager } from 'react-native';

/**
 * Run work only once the in-flight gesture/navigation interaction has settled.
 *
 * Projecting, deduping, sorting and store-writing a relay response is real
 * synchronous JS-thread work. Doing it inside a navigation transition or a
 * gesture drops frames on that exact interaction, which is indistinguishable
 * from a freeze to the person holding the phone — even though nothing is
 * actually blocked. Anything that processes a network response therefore runs
 * behind this, never on the interaction itself.
 *
 * Returns a canceller so an unmounting screen can drop queued work.
 */
export function afterInteractions(run: () => void): () => void {
  const handle = InteractionManager.runAfterInteractions(run);
  return () => handle.cancel();
}

/** Promise form, for awaiting the settle point inside an async orchestration. */
export function whenInteractionsComplete(): Promise<void> {
  return new Promise((resolve) => {
    InteractionManager.runAfterInteractions(() => resolve());
  });
}
