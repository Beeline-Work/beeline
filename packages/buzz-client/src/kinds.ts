/** Buzz / NIP kind constants used by the channel transport. */

/** Stream / channel message (human chat + activity markers). */
export const KIND_STREAM_MESSAGE = 9;

/** NIP-29: put user (membership + role). */
export const KIND_PUT_USER = 9000;

/** NIP-29: remove user from a group. */
export const KIND_REMOVE_USER = 9001;

/** NIP-29: create group/channel. */
export const KIND_CREATE_GROUP = 9007;

/** Channel metadata replaceable. */
export const KIND_CHANNEL_METADATA = 39000;

/** Channel admins list replaceable (`d` = channel UUID). */
export const KIND_CHANNEL_ADMINS = 39001;

/** Channel members list replaceable (`d` = channel UUID). */
export const KIND_CHANNEL_MEMBERS = 39002;

/** NIP-33 parameterized replaceable application data (agent soul overlays). */
export const KIND_AGENT_SOUL = 30078;

/** NIP-33 parameterized replaceable application data (human cosmetic profiles). */
export const KIND_PERSON_PROFILE = 30078;

/** NIP-42 AUTH challenge response. */
export const KIND_AUTH = 22242;

/** Marker tag value for agent-activity body projection (session/update bus). */
export const TAG_AGENT_ACTIVITY = 'agent-activity';

/** Marker tag value for a self-signed first-class agent record. */
export const TAG_AGENT = 'buzz-agent';

/** Marker for a short-lived, single-agent desktop pairing token. */
export const TAG_AGENT_PAIRING = 'buzz-agent-pairing';

/** Marker for display-only, human-authored agent profile metadata. */
export const TAG_AGENT_SOUL = 'buzz-agent-soul';

/** Marker for self-authored, display-only human profile metadata. */
export const TAG_PERSON_PROFILE = 'buzz-person-profile';

/** Marker tag value for merge approval (P0 gate shape — mirrors @beeline/gate). */
export const TAG_MERGE_APPROVAL = 'buzz-merge-approval';

/** App-convention parent-channel linkage tag on child (sub)channels. */
export const TAG_PARENT = 'parent';

/** App-convention community linkage tag on channels and invite events. */
export const TAG_COMMUNITY = 'community';

/** Marker tag value for a signed, channel-scoped community invite. */
export const TAG_COMMUNITY_INVITE = 'buzz-community-invite';

/** Marker tag value for a private, exactly-two-member direct-message Room. */
export const TAG_DIRECT_MESSAGE = 'buzz-dm';
