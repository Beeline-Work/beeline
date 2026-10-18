// Reuse the native proof boundaries, retaining the production live socket.
const boundaries = { ...require('../offline-proof/boundaries.cjs') };
delete boundaries['@/sync/transport/live-connection'];
module.exports = {
  ...boundaries,
  '@/auth/monolith-session': 'session.js',
  '@/buzz/runtime-config': 'runtime.js',
};
