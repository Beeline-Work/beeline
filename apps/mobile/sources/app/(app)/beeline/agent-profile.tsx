import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import BuzzMembers from './members';

export default function AgentProfileRoute() {
  const { agentId, communityId } = useLocalSearchParams<{ agentId: string; communityId: string }>();
  return <BuzzMembers profileAgentId={agentId} workspaceIdOverride={communityId} />;
}
