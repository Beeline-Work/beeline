import type { InviteView } from '@beeline/api-contract/phone';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';

function count(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`;
}

/** "Mara invited you to a workspace with 8 people and 4 agents." */
export function inviteSummary(invite: InviteView): string {
  const who = invite.inviter?.name ?? 'Someone';
  const people = invite.memberCount;
  const agents = invite.agentCount ?? 0;
  const size =
    people === undefined
      ? ''
      : ` with ${count(people, 'person', 'people')}${agents ? ` and ${count(agents, 'agent', 'agents')}` : ''}`;
  return `${who} invited you to a ${WORKSPACE_LABEL.toLowerCase()}${size}.`;
}

/** The inviter's standing, as the confirmation card states it. */
export function inviterRoleLabel(role: NonNullable<InviteView['inviter']>['role']): string {
  if (role === 'owner') return `${WORKSPACE_LABEL} owner`;
  if (role === 'admin') return `${WORKSPACE_LABEL} admin`;
  return 'Member';
}
