/** Fail closed before arming a timer if the intended entry is not available. */
export function isKeyboardShown(inputMethodDump) {
  // InputMethodService can retain its last view while the system hides the IME.
  const system = inputMethodDump.match(/\bmInputShown=(true|false)\b/);
  if (system) return system[1] === 'true';
  return /\bmIsInputViewShown=true\b/.test(inputMethodDump);
}

export function pointFor(xml, attribute, label) {
  const node = [...xml.matchAll(/<node\b[^>]*>/g)].map((m) => m[0]).find((node) => node.includes(` ${attribute}="${label}"`));
  const b = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!b || +b[3] <= +b[1] || +b[4] <= +b[2]) return null;
  return [Math.round((+b[1] + +b[3]) / 2), Math.round((+b[2] + +b[4]) / 2)];
}
export function requireRoomList(xml) {
  if (pointFor(xml, 'content-desc', 'Close Workspace switcher')) throw new Error('Workspace overlay covers the Room list');
  if (!pointFor(xml, 'content-desc', 'all conversations')) throw new Error('Room-list precondition missing; sign in before capture');
  if (!pointFor(xml, 'content-desc', 'Latency Rig 200 — switch Workspace'))
    throw new Error('Select the Latency Rig 200 Workspace before capture');
  const point = pointFor(xml, 'text', '#Rig room 001');
  if (!point) throw new Error('Select the Latency Rig 200 Workspace before capture');
  return point;
}
