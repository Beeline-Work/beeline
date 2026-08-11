type RoomMember = { pubkey: string };
type RoomAgent = { pubkey: string };

export type RoomParticipantCounts = {
  humans: number;
  agents: number;
};

/** Split direct Room membership into people and registered Workspace agents. */
export function countRoomParticipants(
  members: RoomMember[],
  workspaceAgents: RoomAgent[],
): RoomParticipantCounts {
  const agentPubkeys = new Set(workspaceAgents.map((agent) => agent.pubkey));
  const agents = members.filter((member) => agentPubkeys.has(member.pubkey)).length;
  return { humans: Math.max(0, members.length - agents), agents };
}

/** Person-facing Room header summary. Technical repository IDs belong in review details. */
export function formatRoomParticipantCounts({ humans, agents }: RoomParticipantCounts): string {
  return `${humans} ${humans === 1 ? 'human' : 'humans'} · ${agents} ${agents === 1 ? 'agent' : 'agents'}`;
}
