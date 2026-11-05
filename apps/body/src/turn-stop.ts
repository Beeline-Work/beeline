

/**
 * The requester stopped this turn while it was running.
 *
 * Not a failure, and deliberately not reported as one: the server settled the
 * receipt `cancelled` and inscribed who stopped it when it accepted the stop,
 * so a `failed` receipt here would only try — and be refused — to restate a
 * turn that already has its ending, under a word that blames the helper for
 * obeying.
 */
export class TurnStoppedError extends Error {
  override readonly name = 'TurnStoppedError';
}
