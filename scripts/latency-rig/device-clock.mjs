/** Device paint marks and host network spans must share a calibrated epoch. */
export const MAX_CLOCK_UNCERTAINTY_MS = 25;

function validate(anchor) {
  if (!anchor || ![anchor.deviceMs, anchor.hostBeforeMs, anchor.hostAfterMs].every(Number.isFinite) ||
      anchor.hostAfterMs < anchor.hostBeforeMs || anchor.deviceMs < 0)
    throw new Error('Invalid device clock calibration');
  // Both epoch readings are rounded to milliseconds.
  const uncertaintyMs = (anchor.hostAfterMs - anchor.hostBeforeMs) / 2 + 1;
  if (uncertaintyMs > MAX_CLOCK_UNCERTAINTY_MS)
    throw new Error('Device clock calibration is too uncertain');
  return { offsetMs: (anchor.hostBeforeMs + anchor.hostAfterMs) / 2 - anchor.deviceMs, uncertaintyMs };
}

export function sampleDeviceClock(readDeviceMs, now = Date.now) {
  const hostBeforeMs = now();
  const deviceMs = Number(readDeviceMs());
  const hostAfterMs = now();
  const anchor = { deviceMs, hostBeforeMs, hostAfterMs };
  validate(anchor);
  return anchor;
}

export function calibrateDeviceClock(readDeviceMs, now = Date.now) {
  const anchors = [];
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { anchors.push(sampleDeviceClock(readDeviceMs, now)); }
    catch (error) { failure = error; }
  }
  if (!anchors.length) throw failure;
  return anchors.reduce((best, anchor) =>
    validate(anchor).uncertaintyMs < validate(best).uncertaintyMs ? anchor : best);
}

export function hostClockMoment(moment) {
  if (![moment.startMs, moment.paintMs, moment.endMs].every(Number.isFinite) ||
      moment.paintMs < moment.startMs || moment.endMs < moment.paintMs)
    throw new Error('Invalid moment timestamps');
  if (moment.clockDomain === 'host') return moment;
  if (moment.clockDomain !== 'device' || !moment.clockSync?.before || !moment.clockSync?.after)
    throw new Error('Moment needs an explicit host clock domain or before/after device calibration');
  const before = validate(moment.clockSync.before);
  const after = validate(moment.clockSync.after);
  const driftMs = Math.abs(after.offsetMs - before.offsetMs);
  if (driftMs > before.uncertaintyMs + after.uncertaintyMs + 1)
    throw new Error('Device clock changed during the sample');
  if (moment.startMs < moment.clockSync.before.deviceMs || moment.endMs < moment.paintMs ||
      moment.clockSync.after.deviceMs < moment.endMs)
    throw new Error('Device clock anchors do not bound the sample');
  const clockUncertaintyMs = Math.max(before.uncertaintyMs + driftMs, after.uncertaintyMs);
  if (clockUncertaintyMs > MAX_CLOCK_UNCERTAINTY_MS)
    throw new Error('Device clock calibration is too uncertain');
  return { ...moment, clockDomain: 'host', clockUncertaintyMs,
    deviceStartMs: moment.startMs, devicePaintMs: moment.paintMs, deviceEndMs: moment.endMs,
    startMs: moment.startMs + before.offsetMs,
    paintMs: moment.paintMs + before.offsetMs,
    endMs: moment.endMs + before.offsetMs,
    ...(moment.canonicalMs === undefined ? {} : { canonicalMs: moment.canonicalMs + before.offsetMs }) };
}
