import { fallbackAgentName } from './agent-display';
import { WORKSPACE_LABEL } from './vocabulary';

export interface AgentPersonaDefaults {
  name: string;
  soul: string;
}

/** Stable, entirely local copy used to seed the editable persona form. */
export function defaultAgentPersona(pubkey: string): AgentPersonaDefaults {
  return {
    name: fallbackAgentName(pubkey),
    soul: `Steady, practical, and ready to help this ${WORKSPACE_LABEL}.`,
  };
}
