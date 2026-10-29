/** Append the Trusty Squire native proof's adapters to the existing Metro resolver.
 *  Temporary: in metro.config.js, `module.exports = require('./scripts/proof-shims/metro.cjs')(config, __dirname);` */
const path = require('node:path');
module.exports = (config, mobile) => {
  const original = config.resolver.resolveRequest;
  const shim = (file) => ({ filePath: path.join(mobile, 'scripts/proof-shims', file), type: 'sourceFile' });
  config.resolver.resolveRequest = (context, name, platform) => {
    if (name === 'expo-router') return shim('expo-router.tsx');
    const resolved = original ? original(context, name, platform) : context.resolveRequest(context, name, platform);
    const file = resolved && resolved.filePath ? resolved.filePath : '';
    if (file.endsWith('sources/sync/transport/live-connection.ts')) return shim('live-connection.ts');
    if (/sources[\\/]auth[\\/]buzz-identity-storage\.tsx?$/.test(file) && !String(context.originModulePath).includes('proof-shims'))
      return shim('buzz-identity-storage.ts');
    return resolved;
  };
  return config;
};
