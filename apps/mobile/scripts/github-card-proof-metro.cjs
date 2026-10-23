/** Append these fixture adapters to the existing Metro resolver for local proof. */
const path = require('node:path');
module.exports = (config, mobile) => {
  const original = config.resolver.resolveRequest;
  const aliases = new Set(['expo-router', '@/buzz/onboarding-rollout', '@/sync/transport/monolith-operation',
    '@/auth/buzz-identity-storage', '@/sync/transport/room-view-client', '@/buzz/surface-storage',
    '@/buzz/community-storage', '@/buzz/enter-workspace', '@/buzz/latency-route-hook', '@/components/buzz/CommunityRail']);
  config.resolver.resolveRequest = (context, name, platform) => aliases.has(name)
    ? { filePath: path.join(mobile, 'scripts/github-card-proof-adapters.tsx'), type: 'sourceFile' }
    : original(context, name, platform);
  return config;
};
