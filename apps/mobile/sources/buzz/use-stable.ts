import { useRef } from 'react';

/**
 * Reference-identity preservation for derived render inputs.
 *
 * Several per-render derivations in the chat screen (membership projections,
 * attribution sets, id→message maps, presence verdicts) produce a NEW object
 * on every commit even when their VALUE did not change. Any of them feeding
 * `renderItem`'s dependency array then recreates the callback, which forces
 * VirtualizedList to re-invoke renderItem for every visible ledger row —
 * the systemic corner-screen saturation behind the send / modal-open freezes.
 *
 * `useStable` keeps the previous reference while a caller-supplied comparator
 * says the value is unchanged, so downstream memoization (useCallback deps,
 * React.memo bailouts) survives churn that cannot be seen on screen.
 *
 * The ref write happens during render on purpose: this is the same
 * derive-and-freeze pattern the screen already uses for its presence refs,
 * and deferring it to an effect would hand one render a stale reference.
 */
export function useStable<T>(value: T, equal: (previous: T, next: T) => boolean): T {
  const ref = useRef(value);
  if (ref.current !== value && !equal(ref.current, value)) {
    ref.current = value;
  }
  return ref.current;
}

/** Field-wise equality for flat records whose values are primitives. */
export function shallowEqualRecord(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): boolean {
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return false;
  for (const key of nextKeys) {
    if (previous[key] !== next[key]) return false;
  }
  return true;
}

/** Membership-inspecting equality for string sets. */
export function sameStringSet(previous: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  if (previous === next) return true;
  if (previous.size !== next.size) return false;
  for (const value of next) {
    if (!previous.has(value)) return false;
  }
  return true;
}

/**
 * Equality for id→message lookup maps: same keys, and each key mapping to the
 * SAME message object reference, so a changed mapping means row content moved.
 */
export function sameMessageRefMap<T>(
  previous: ReadonlyMap<string, T>,
  next: ReadonlyMap<string, T>,
): boolean {
  if (previous === next) return true;
  if (previous.size !== next.size) return false;
  for (const [key, value] of next) {
    if (previous.get(key) !== value) return false;
  }
  return true;
}

/** Field-wise equality for one selected Room member. */
function sameSelectedMember(
  previous: {
    pubkey: string;
    role?: unknown;
    kind?: unknown;
    identity?: unknown;
  },
  next: {
    pubkey: string;
    role?: unknown;
    kind?: unknown;
    identity?: unknown;
  },
): boolean {
  return (
    previous.pubkey === next.pubkey &&
    previous.role === next.role &&
    previous.kind === next.kind &&
    previous.identity === next.identity
  );
}

/** Element-wise equality for the Room membership projection arrays. */
export function sameSelectedMembers(
  previous: readonly {
    pubkey: string;
    role?: unknown;
    kind?: unknown;
    identity?: unknown;
  }[],
  next: readonly {
    pubkey: string;
    role?: unknown;
    kind?: unknown;
    identity?: unknown;
  }[],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (!sameSelectedMember(previous[index]!, next[index]!)) return false;
  }
  return true;
}
