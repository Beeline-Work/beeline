/** Propagation overlaps between packets; only link serialization queues. */
export function messageSchedule() {
  let availableAt = 0;
  return (arrivedAt, propagationMs, serializationMs) => {
    if (![arrivedAt, propagationMs, serializationMs].every((value) => Number.isFinite(value) && value >= 0))
      throw new Error('Invalid message shaping interval');
    availableAt = Math.max(availableAt, arrivedAt + propagationMs) + serializationMs;
    return availableAt;
  };
}
