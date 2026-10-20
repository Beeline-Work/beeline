/** The target message, rather than the cached tail, ends an arrival sample. */
export function validateArrivalCases(cases) {
  const required = ['room-list-unseen-1', 'room-list-unseen-5', 'push-unseen-1', 'push-unseen-5'];
  if (!Array.isArray(cases) || cases.length !== required.length ||
      new Set(cases.map((item) => item.name)).size !== required.length)
    throw new Error('arrival matrix requires four distinct cases');
  for (const name of required) {
    const item = cases.find((item) => item.name === name);
    if (!item || item.budgetMs !== 450 ||
        name !== `${item.entry}-unseen-${item.unseen}` || ![1, 5].includes(item.unseen))
      throw new Error(`missing or unbudgeted arrival case: ${name}`);
  }
}

export function extractArrivalMoments(logcat, attempts) {
  const moments = [];
  const marks = logcat.split(/\r?\n/).flatMap((line) => {
    const match = /\[ROOM_OPEN\]\s*(\{.*\})/.exec(line);
    const epoch = /^\s*(\d{10})\.(\d{3})\s/.exec(line);
    return match && epoch ? [{ ...JSON.parse(match[1]), epochMs: Number(epoch[1]) * 1000 + Number(epoch[2]) }] : [];
  });
  for (const attempt of attempts) {
    if (!attempt.targetId || !Number.isFinite(attempt.startMs) ||
        !Number.isFinite(attempt.endMs) || attempt.endMs <= attempt.startMs)
      throw new Error('arrival attempt requires target id and bounded action timestamps');
    const frame = marks.find((mark) => mark.phase === 'newest-frame' &&
      mark.detail === attempt.targetId && mark.epochMs >= attempt.startMs && mark.epochMs <= attempt.endMs);
    if (!frame) throw new Error(`target message never painted: ${attempt.name}/${attempt.targetId}`);
    moments.push({ kind: 'route', name: '/beeline/chat/[channelId]', variant: attempt.name,
      startMs: attempt.startMs, paintMs: frame.epochMs, endMs: attempt.endMs });
  }
  return moments;
}

/** A native result exists only after the unique row is visible above the composer. */
export function nativeArrivalMoment(output, name) {
  const match = /LATENCY_VISIBLE (\{[^\r\n]*\})/.exec(output);
  if (!match) throw new Error(`Newest message never became visible: ${name}`);
  const mark = JSON.parse(match[1]);
  if (mark.probe !== 'native-frame-commit-v1' || mark.case !== name || !Number.isFinite(mark.startMs) || !Number.isFinite(mark.paintMs) || mark.paintMs < mark.startMs)
    throw new Error('Invalid native visibility timestamps');
  return { kind: 'route', name: '/beeline/chat/[channelId]', variant: name,
    startMs: mark.startMs, paintMs: mark.paintMs };
}
