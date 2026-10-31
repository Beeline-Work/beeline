const path = require('path');
module.exports = (config) => {
  const previous = config.resolver.resolveRequest;
  const mocked = new Set([
    'expo-router', '@/utils/responsive', '@/buzz/latency-route-hook',
    '@/buzz/use-observed-resource', '@/buzz/workbench-source', '@/buzz/workbench-surface',
    '@/sync/transport/monolith-operation',
  ]);
  config.resolver.resolveRequest = (context, name, platform) => mocked.has(name)
    ? { type: 'sourceFile', filePath: path.join(__dirname, 'state.ts') }
    : previous(context, name, platform);
  return config;
};
