import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import BuzzMembers from './members';

export default function AgentProfileRoute() {
  useLatencyRouteFrame('/beeline/agent-profile');
  const { agentId, communityId } = useLocalSearchParams<{ agentId: string; communityId: string }>();
  return <BuzzMembers profileAgentId={agentId} workspaceIdOverride={communityId} />;
}
