import { observePhoneInput, type InputObservation } from '@beeline/net/phone-inputs';

/** M1 shadow only. No executor, pass minting, clock, telemetry or callbacks.
 * These observations never authorize work and never leave this process. */
export class RouteObservation {
  private readonly entries: InputObservation[] = [];
  private bytes = 2; // JSON array brackets

  observe(operation: string, input: unknown): void {
    const entry = observePhoneInput(operation, input);
    // Route names and verdicts are closed ASCII literals; never store input or
    // arbitrary operation/error text. Counting JSON bytes is exact here.
    const size = JSON.stringify(entry).length + 1;
    while (this.entries.length && (this.entries.length >= 100 || this.bytes + size > 16 * 1024))
      this.bytes -= JSON.stringify(this.entries.shift()!).length + 1;
    this.entries.push(Object.freeze(entry));
    this.bytes += size;
  }

  snapshot(): readonly InputObservation[] { return this.entries.slice(); }
  clear(): void { this.entries.length = 0; this.bytes = 2; }
}
