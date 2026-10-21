import { createMonolithAuth } from '../../apps/server/src/monolith-auth.js';
import { createBeelineServer } from '../../apps/server/src/server.js';
import { PgliteDatabase } from '../../apps/server/src/test-support.js';
import { migrate } from '../../apps/server/src/database.js';
import { AuthStore } from '@beeline/auth/store';
import { LiveHub } from '../../apps/server/src/live.js';
const database = new PgliteDatabase();
await migrate(database);
await new AuthStore(database as never).migrate();
const origin = 'http://127.0.0.1:4319';
const mount = await createMonolithAuth(database, origin, undefined, {
  createDaemonExchange: async () => { throw new Error('unused'); },
  env: {
    NODE_ENV: 'test',
    BEELINE_GOOGLE_SIGN_IN: '1',
    BEELINE_GOOGLE_SIGN_IN_PREVIEW_TOKEN: 'p'.repeat(43),
    BEELINE_GOOGLE_SIGN_IN_SUBJECTS: 'google-owner',
    BEELINE_AUTH_TENANTS_JSON: JSON.stringify([{host:'127.0.0.1:4319',origin,community:'preview-proof',roomCommunityIds:['preview-proof']}]),
    BEELINE_AUTH_OIDC_ISSUER: 'https://accounts.example',
    BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
    BEELINE_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
    BEELINE_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
    BEELINE_AUTH_OIDC_CLIENT_ID: 'test-client',
  },
});
const server = createBeelineServer({ database, auth: {} as never, phone: {} as never,
  daemon: {} as never, live: new LiveHub(), authHandler: mount.handle,
  mediaMaximumBytes: 1, webAppOrigins: ['http://localhost:8089', 'http://127.0.0.1:8089'],
});
await new Promise<void>(resolve => server.listen(4319, '127.0.0.1', resolve));
console.log('Google preview fixture ready on 4319');
