'use strict';
const { createHash } = require('node:crypto');

// Read only the protocol envelope. Arguments, results, auth and raw ids stay private.
function phoneFrame(data, isBinary = false) {
  if (isBinary || (!Buffer.isBuffer(data) && typeof data !== 'string')) return null;
  let frame;
  try { frame = JSON.parse(String(data)); } catch { return null; }
  if (!frame || typeof frame !== 'object' || typeof frame.id !== 'string' ||
      !frame.id || frame.id.length > 128) return null;
  if (frame.t === 'req' && Buffer.byteLength(data) <= 65536 &&
      typeof frame.op === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(frame.op) &&
      frame.args && typeof frame.args === 'object' && !Array.isArray(frame.args))
    return { t: 'req', id: frame.id, op: frame.op };
  if (frame.t === 'res' && typeof frame.ok === 'boolean') return { t: 'res', id: frame.id, ok: frame.ok };
  return null;
}

function socketRequestTrace(connectionTrace, id) {
  return createHash('sha256').update(`${connectionTrace}\0${id}`).digest('hex');
}

module.exports = { phoneFrame, socketRequestTrace };
