const path = require('path');
const config = require('../../metro.search-base.cjs');
const base = config.resolver.resolveRequest;
const mocks = ['expo-router', '@/auth/buzz-identity-storage', '@/buzz/surface-storage', '@/buzz/use-shared-surface', '@/buzz/workspace-records', '@/buzz/workspace-watch', '@/sync/transport/room-view-client', '@/sync/transport/live-connection', '@/sync/transport', '@/buzz/latency-route-hook', '@/buzz/use-active-community', '@/buzz/workbench-surface', '@/buzz/company-connection-actions'];
config.resolver.resolveRequest = (ctx, name, platform) => mocks.includes(name) ? {type:'sourceFile',filePath:path.join(__dirname,'mocks.tsx')} : base(ctx,name,platform);
module.exports = config;
