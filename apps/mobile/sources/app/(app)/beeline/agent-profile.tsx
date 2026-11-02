import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { useSurfaceFocus } from '@/buzz/use-surface-focus';
import { routerOwnerUsageProfile } from '@/buzz/router-owner';
import React, { useEffect } from 'react';
import { useLocalSearchParams } from 'expo-router';
import BuzzMembers from './members';

export default function AgentProfileRoute() {
  useLatencyRouteFrame('/beeline/agent-profile');
  const { agentId, communityId } = useLocalSearchParams<{ agentId: string; communityId: string }>();
  const focused = useSurfaceFocus();
  useEffect(() => {
    if (focused && agentId) routerOwnerUsageProfile(agentId);
    // Navigation revokes on real blur. Observer cleanup cannot revoke/remint
    // committed profile ownership during StrictMode's setup rehearsal.
  }, [agentId, focused]);
  return <BuzzMembers profileAgentId={agentId} workspaceIdOverride={communityId} />;
}
