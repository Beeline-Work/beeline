/** The release version is intentionally a small, fixed wire format. Unknown
 * helper versions fail closed only after an operator configures a minimum. */
const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/;

function parts(version: string): readonly number[] | null {
  const match = VERSION.exec(version);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  return values.every(Number.isSafeInteger) ? values : null;
}

export function helperVersionBelowMinimum(version: string | undefined, minimum: string): boolean {
  const left = version && parts(version);
  const right = parts(minimum);
  if (!right) throw new Error('invalid minimum helper version');
  if (!left) return true;
  for (let index = 0; index < right.length; index++) {
    if (left[index]! < right[index]!) return true;
    if (left[index]! > right[index]!) return false;
  }
  return false;
}

export class HelperVersionGate {
  #minimum: string | undefined;
  readonly #listeners = new Set<(minimum: string) => void>();

  constructor(initialMinimum?: string) {
    if (initialMinimum) this.raise(initialMinimum);
  }

  get minimum(): string | undefined { return this.#minimum; }

  /** A release may raise the minimum on a running Machine. Configure the same
   * value in its environment so the gate survives a later process restart. */
  raise(minimum: string): void {
    if (!parts(minimum)) throw new Error('invalid minimum helper version');
    if (this.#minimum && helperVersionBelowMinimum(minimum, this.#minimum))
      throw new Error('minimum helper version cannot decrease');
    if (minimum === this.#minimum) return;
    this.#minimum = minimum;
    for (const listener of this.#listeners) listener(minimum);
  }

  subscribe(listener: (minimum: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
