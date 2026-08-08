/** Buzz / NIP kind constants used by the channel transport. */

/** Stream / channel message (human chat + activity markers). */
export const KIND_STREAM_MESSAGE = 9;

/** NIP-29: put user (membership + role). */
export const KIND_PUT_USER = 9000;

/** NIP-29: create group/channel. */
export const KIND_CREATE_GROUP = 9007;

/** Channel metadata replaceable. */
export const KIND_CHANNEL_METADATA = 39000;

/** Channel members list replaceable (`d` = channel UUID). */
export const KIND_CHANNEL_MEMBERS = 39002;

/** NIP-42 AUTH challenge response. */
export const KIND_AUTH = 22242;

/** Marker tag value for agent-activity body projection (session/update bus). */
export const TAG_AGENT_ACTIVITY = 'agent-activity';

/** Marker tag value for merge approval (P0 gate shape — mirrors @buzzy/gate). */
export const TAG_MERGE_APPROVAL = 'buzz-merge-approval';

/** App-convention parent-channel linkage tag on child (sub)channels. */
export const TAG_PARENT = 'parent';
