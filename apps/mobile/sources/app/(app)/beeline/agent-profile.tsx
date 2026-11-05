import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { useSurfaceFocus } from '@/buzz/use-surface-focus';

import { useLocalSearchParams } from 'expo-router';
import BuzzMembers from './members';

export default function AgentProfileRoute() {
  useLatencyRouteFrame('/beeline/agent-profile');
  const { agentId, communityId } = useLocalSearchParams<{ agentId: string; communityId: string }>();
  const focused = useSurfaceFocus();

  return <BuzzMembers profileAgentId={agentId} workspaceIdOverride={communityId} />;
}
