/** Streaming WSOLA for 24 kHz mono PCM. Leading silence and the first voiced
 * 20 ms frame pass immediately; silence is not included in the speed change.
 * later windows advance 1.15 hops, aligned by waveform correlation, rather
 * than changing the sample rate (and therefore pitch). */
export async function* voiceTempo(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const hop = 480, search = 120, speed = 1.15;
  let bytes = Buffer.alloc(0), samples: number[] = [], base = 0, total = 0;
  let emitted = 0, step = 0, previous = 0;
  const sample = (index: number) => samples[index - base] ?? 0;
  const encode = (values: number[]) => {
    const out = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), index * 2));
    return out;
  };
  function* available(final: boolean) {
    // Do not spend the no-lookahead opening frame on provider padding. Keep
    // passing silent frames until speech arrives, then start WSOLA there.
    if (!step && total >= hop && samples.slice(0, hop).every(value => value === 0)) {
      yield encode(samples.slice(0, hop));
      samples = samples.slice(hop); total -= hop;
      return;
    }
    const target = final ? Math.max(Math.min(total, hop), Math.round(total / speed)) : Infinity;
    if (!step && total >= hop) {
      yield encode(samples.slice(0, hop)); emitted = hop; step = 1;
    }
    while (step && emitted < target) {
      const nominal = Math.round(step * hop * speed);
      if (!final && total < nominal + search + 2 * hop) break;
      if (final && total <= nominal) break;
      let best = Math.min(nominal, total - 1), score = -Infinity;
      const limit = Math.min(nominal + search, total - hop);
      for (let at = Math.max(base, nominal - search); at <= limit; at++) {
        let dot = 0, energyA = 0, energyB = 0;
        // Decimated correlation still searches every sample offset.
        for (let i = 0; i < hop; i += 4) {
          const a = sample(previous + hop + i), b = sample(at + i);
          dot += a * b; energyA += a * a; energyB += b * b;
        }
        const correlation = dot / Math.sqrt(Math.max(1, energyA * energyB));
        if (correlation > score) { score = correlation; best = at; }
      }
      const count = Math.min(hop, target - emitted);
      yield encode(Array.from({ length: count }, (_, i) => {
        const weight = i / hop;
        return sample(previous + hop + i) * (1 - weight) + sample(best + i) * weight;
      }));
      emitted += count; previous = best; step++;
      const keep = Math.min(previous, Math.round(step * hop * speed) - search);
      if (keep > base) { samples = samples.slice(keep - base); base = keep; }
    }
    if (final && emitted < target) {
      yield encode(Array.from({ length: target - emitted }, (_, i) => sample(Math.min(total - 1, previous + hop + i))));
    }
  }
  for await (const chunk of input) {
    bytes = Buffer.concat([bytes, chunk]);
    // Decode only one frame at a time, so a large provider chunk cannot delay
    // the opening frame while we process the entire utterance.
    while (bytes.length >= 2) {
      const count = Math.min(hop, Math.floor(bytes.length / 2));
      for (let i = 0; i < count; i++) samples.push(bytes.readInt16LE(i * 2));
      total += count; bytes = bytes.subarray(count * 2);
      yield* available(false);
    }
  }
  if (!step) { yield encode(samples); return; }
  yield* available(true);
}
