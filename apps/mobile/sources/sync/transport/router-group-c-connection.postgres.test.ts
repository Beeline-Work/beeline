import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Client, Pool } from 'pg';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from '../../../../server/src/database.js';

const app = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>(), currentState: 'active', origin: '',
  network: undefined as undefined | ((state: { type: string; isConnected: boolean; isInternetReachable: boolean; details: { ipAddress: string } }) => void),
}));
const netInfo = vi.hoisted(() => ({ configure: vi.fn(), addEventListener: vi.fn((listener: NonNullable<typeof app.network>) => {
  app.network = listener; return () => { app.network = undefined; };
}) }));
vi.mock('@react-native-community/netinfo', () => ({ default: netInfo }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: app.origin }) }));

vi.mock('react-native', () => ({ AppState: {
  get currentState() { return app.currentState; },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    app.listeners.add(listener); return { remove: () => app.listeners.delete(listener) };
  },
}, NativeModules: { RNCNetInfo: {} }, Platform: { OS: 'android' } }));
import { monolithSession } from '@/auth/monolith-session';

const authStorage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => authStorage.get(key) ?? null,
  setItem: async (key: string, value: string) => { authStorage.set(key, value); },
  removeItem: async (key: string) => { authStorage.delete(key); },
} }));
vi.mock('expo-linking', () => ({ createURL: (path: string) => `beeline://${path}` }));
vi.mock('@/auth/desktop-auth-redirect', () => ({ desktopAuthRedirectUri: (_name: string, fallback: string) => fallback }));
const googlePicker = vi.hoisted(() => ({ enabled: false, signIn: vi.fn() }));
vi.mock('@/auth/google-account-picker', () => ({ get googleAccountPicker() { return googlePicker.enabled ? googlePicker : null; } }));
import { runGoogleSignIn, resumeGoogleSignIn } from '@/auth/google-auth-session';
import { runResilientGitHubSignInSession, resumeInitialGitHubSignIn } from '@/auth/github-auth-session';
import { AuthStore, type BindTicket } from '../../../../auth/src/store.js';
import { waitForAuthTicket } from '../../../../auth/src/completion-wait.js';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion, subscribeCommandCompletion } from '../../../../server/src/command-completion.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Group C connection proof requires isolated loopback PostgreSQL');
const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
const hidden = '33333333-3333-4333-8333-333333333333', viewer = 'synthetic-reader';
const input = { family: 'room-head' as const, workspaceId: workspace, roomId: room };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

// Actual preauth clients/HTTP, independent PostgreSQL pools, durable ticket
// capture and LISTEN wake. Browser/OS callback delivery and the HTTP response
// serializer are explicit synthetic seams; no installed-native claim is made.
describe.skipIf(!url)('Group D P9 correlated native callback adapter composition', () => {
  it('F11: cancellation during native lost-response recovery burns the committed ticket without returning it', async () => {
    authStorage.clear(); googlePicker.enabled = true; googlePicker.signIn.mockResolvedValue('synthetic-native-id-token');
    const schema = `group_d_native_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 2 };
    const readerDb = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const writerDb = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const reader = new AuthStore(readerDb), writer = new AuthStore(writerDb);
    const state = 's'.repeat(43), browserToken = 'r'.repeat(43);
    const token = createHash('sha256').update(`beeline-google-native:${browserToken}`).digest('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const inspected = deferred(), release = deferred(), controller = new AbortController();
    const pending: Promise<unknown>[] = [], errors: unknown[] = [];
    let requests = 0, reads = 0, cancellations = 0;
    // Native picker/HTTP serialization are synthetic. Ticket commit, independent
    // recovery read, client cancellation fence and durable ticket burn are real.
    const server = createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const work = (async () => {
          requests++;
          const args = JSON.parse(body);
          if (request.url === '/auth/oidc/native/start') {
            expect(args.recoveryChallenge).toBe(hash);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ state, nonce: 'n'.repeat(43), serverClientId: 'synthetic.apps.googleusercontent.com' }));
            return;
          }
          expect(args.recoveryToken).toBe(token);
          if (request.url === '/auth/oidc/native/complete') {
            expect(args.idToken).toBe('synthetic-native-id-token');
            await writer.createTicket(hash, { challenge: 'c'.repeat(43), community: 'synthetic.test', issuer: 'https://accounts.google.com',
              audience: 'fixture', subject: 'synthetic-person', createdAt: new Date(), expiresAt: new Date(Date.now() + 120_000),
              attemptCount: 0, consumedAt: null, boundPubkey: null });
            response.destroy(); // The commit succeeded; only its HTTP response is lost.
            return;
          }
          if (request.url === '/auth/oidc/completion') {
            reads++; const ticket = await reader.findTicket(hash);
            expect(ticket).toMatchObject({ consumedAt: null, subject: 'synthetic-person' });
            inspected.resolve(); await release.promise;
            response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}');
            return;
          }
          expect(request.url).toBe('/auth/oidc/completion/cancel');
          cancellations++; await writer.cancelRecoveryTicket(hash, new Date());
          response.writeHead(204); response.end();
        })(); pending.push(work); void work.catch(error => { errors.push(error); inspected.resolve(); response.destroy(error); });
      });
    });
    try {
      await writer.migrate();
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      app.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const browser = vi.fn();
      const result = runGoogleSignIn({ state, recoveryToken: browserToken, signal: controller.signal,
        openAuthSession: browser, subscribeToUrls: () => ({ remove() {} }) });
      const outcome = result.then(value => ({ value }), error => ({ error }));
      await inspected.promise;
      expect({ requests, reads, cancellations }).toEqual({ requests: 3, reads: 1, cancellations: 0 });
      controller.abort(); release.resolve();
      expect(await outcome).toMatchObject({ error: { code: 'browser_canceled' } });
      expect({ requests, reads, cancellations }).toEqual({ requests: 4, reads: 1, cancellations: 1 });
      expect((await reader.findTicket(hash))?.consumedAt).toBeInstanceOf(Date);
      expect(browser).not.toHaveBeenCalled(); expect(authStorage.size).toBe(0); expect(errors).toEqual([]);
    } finally {
      controller.abort(); release.resolve(); googlePicker.enabled = false;
      await Promise.allSettled(pending); await new Promise<void>(resolve => server.close(() => resolve()));
      await readerDb.close(); await writerDb.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  }, 20_000);

  it.each(['github', 'google'] as const)('F11: %s warm/cold callbacks share one held HTTP request and committed ticket', async provider => {
    authStorage.clear();
    const schema = `group_d_auth_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 2 };
    const readerDb = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const writerDb = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const listener = new Client(config), reader = new AuthStore(readerDb), writer = new AuthStore(writerDb);
    const inspected = deferred(); let requests = 0, reads = 0;
    const state = 's'.repeat(43), token = 'r'.repeat(43);
    const hash = createHash('sha256').update(token).digest('hex');
    const pending: Promise<unknown>[] = [], controllers = new Set<AbortController>();
    const server = createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const controller = new AbortController(); controllers.add(controller);
        response.once('close', () => { controller.abort(); controllers.delete(controller); });
        const work = (async () => {
          requests++;
          const args = JSON.parse(body) as { recoveryToken: string; waitMs?: number };
          expect(args.recoveryToken).toBe(token);
          const ticket = await waitForAuthTicket(wake => subscribeCommandCompletion({ principal: 'auth', operation: 'ticket', commandId: hash }, wake),
            async () => { reads++; const found = await reader.findTicket(hash); inspected.resolve(); return found; }, args.waitMs ?? 0, controller.signal);
          response.writeHead(ticket ? 200 : 202, { 'content-type': 'application/json' });
          response.end(JSON.stringify(ticket ? {
            protocol: 1, kind: 24250, marker: 'beeline-oidc-bind-v1', ticket: token,
            challenge: ticket.challenge, provider: ticket.issuer, audience: ticket.audience,
            subject: ticket.subject, community: ticket.community,
            issued_at: Math.floor(ticket.createdAt.getTime() / 1000), expires_at: Math.floor(ticket.expiresAt.getTime() / 1000),
          } : {}));
        })(); pending.push(work); void work.catch(error => response.destroy(error));
      });
    });
    try {
      await writer.migrate(); await listener.connect();
      listener.on('notification', event => { if (event.channel === COMMAND_COMPLETION_CHANNEL && event.payload) notifyCommandCompletion(event.payload); });
      await listener.query(`LISTEN ${COMMAND_COMPLETION_CHANNEL}`);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      app.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const browser = { state, recoveryToken: token, platform: 'android', openAuthSession: async () => ({ type: 'opened' }), subscribeToUrls: () => ({ remove() {} }) };
      const warm = provider === 'github' ? runResilientGitHubSignInSession(browser) : runGoogleSignIn(browser);
      const warmResult = warm.then(value => ({ value }), error => ({ error }));
      await inspected.promise;
      const cold = provider === 'github'
        ? resumeInitialGitHubSignIn(async () => `beeline://beeline/github-callback?state=${state}&completed=1`)
        : resumeGoogleSignIn(`beeline://beeline/google-callback?state=${state}&completed=1`);
      const coldResult = cold.then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(119_999);
      expect({ requests, reads }).toEqual({ requests: 1, reads: 1 });
      const ticket: BindTicket = { challenge: 'c'.repeat(43), community: 'synthetic.test', issuer: provider === 'github' ? 'https://github.com' : 'https://accounts.google.com',
        audience: 'fixture', subject: 'synthetic-person', createdAt: new Date(), expiresAt: new Date(Date.now() + 120_000), attemptCount: 0, consumedAt: null, boundPubkey: null };
      await writer.createTicket(hash, ticket);
      const first = await warmResult, second = await coldResult;
      expect(first).toEqual(second);
      if (provider === 'github') expect(first).toMatchObject({ value: { ticket: token, provider: 'https://github.com' } });
      else expect(first).toEqual({ value: token });
      expect({ requests, reads }).toEqual({ requests: 1, reads: 2 });
      await vi.advanceTimersByTimeAsync(600_000);
      expect({ requests, reads }).toEqual({ requests: 1, reads: 2 });
    } finally {
      for (const controller of controllers) controller.abort();
      vi.useRealTimers(); await Promise.allSettled(pending);
      await new Promise<void>(resolve => server.close(() => resolve())); await listener.end();
      await readerDb.close(); await writerDb.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  }, 20_000);
});
