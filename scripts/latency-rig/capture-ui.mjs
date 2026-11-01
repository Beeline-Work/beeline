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

/** Setup only: a valid hierarchy can still show the previous fixture message. */
export async function waitForReactionChip(dump, targetId, step, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const id = `reaction-chip-${targetId}-👍`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // UI Automator can encode emoji numerically in both labels and resource ids.
    const xml = (await dump()).replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, value) =>
      String.fromCodePoint(value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value)));
    const chip = [...xml.matchAll(/<node\b[^>]*>/g)].map(match => match[0]).find(node => node.includes(`resource-id="${id}"`));
    const point = pointFor(xml, 'resource-id', id);
    if (point && chip?.includes('content-desc="👍, 1 reaction"')) return point;
    if (attempt < 3) await wait(1500);
  }
  throw new Error(`Reaction setup requires one existing reaction at ${step} after three hierarchies (target ${targetId.slice(0, 16)})`);
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
