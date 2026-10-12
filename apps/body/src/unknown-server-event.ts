/** A newer server may add frames without requiring every helper to upgrade. */
export function unknownServerEventLogger(stream: string): (type: unknown) => void {
  const seen = new Set<string>();
  return (type) => {
    if (typeof type !== 'string' || seen.has(type) || seen.size >= 64) return;
    seen.add(type);
    // Log only the discriminator, never payloads that may carry credentials.
    console.debug(`[${stream}] ignored unknown server event ${JSON.stringify(type.slice(0, 128))}`);
  };
}
