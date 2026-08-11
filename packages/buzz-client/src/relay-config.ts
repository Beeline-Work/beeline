/** Production relay defaults shared by shipped Beeline clients. */
export const DEFAULT_RELAY_HOST = 'relay.buzzrouter.com';
export const DEFAULT_RELAY_SCHEME = 'https';
export const DEFAULT_RELAY_BASE_URL = `${DEFAULT_RELAY_SCHEME}://${DEFAULT_RELAY_HOST}`;
export const DEFAULT_RELAY_WS_URL = `wss://${DEFAULT_RELAY_HOST}`;
