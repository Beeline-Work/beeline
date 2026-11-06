import { HOST_EMULATOR_TARGET } from '@beeline/api-contract/agent-grants';

export const HOST_EMULATOR_RULE = `Emulators: request_grant(kind:host,target:"${HOST_EMULATOR_TARGET}",reason,purpose); after host Allow call again for an existing one's address, else report unavailable/refused; never start one.`;
