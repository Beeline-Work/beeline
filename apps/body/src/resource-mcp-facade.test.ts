import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, it, expect, vi } from 'vitest';
import {
  drivenUrlIn,
  resourceFacadeArgs,
  squireApprovalCopy,
  squireApprovalFromMcp,
} from './resource-mcp-facade.js';
import { rewriteHostMcpDeclaration } from './host-mcp-route.js';

describe('the page a Squire session is driving', () => {
  it('reads it only from a navigation call that was pointed at it', () => {
    expect(drivenUrlIn('operate_start', { url: 'https://mcp.linear.app/authorize?state=a' })).toBe(
      'https://mcp.linear.app/authorize?state=a',
    );
    expect(drivenUrlIn('operate_login', { url: 'https://provider.test/login' })).toBe(
      'https://provider.test/login',
    );
    expect(drivenUrlIn('operate_navigate', { url: 'https://provider.test/next' })).toBe(
      'https://provider.test/next',
    );
  });

  it('is not satisfied by a URL riding some other call, which would suppress a real handoff', () => {
    // A `use_credential` in the same turn must not overwrite the sign-in page
    // Squire is on: the relayed `signInUrl` would then match no attempt and
    // the owner's one link would be silently skipped for the wrong row.
    expect(
      drivenUrlIn('use_credential', { http: { url: 'https://api.stripe.com/v1/charges' } }),
    ).toBe(undefined);
    expect(drivenUrlIn('operate_click', { ref: 'https://elsewhere.test/page' })).toBe(undefined);
    expect(drivenUrlIn('operate_start', { reason: 'https://elsewhere.test/page' })).toBe(undefined);
    expect(drivenUrlIn(undefined, { url: 'https://provider.test/login' })).toBe(undefined);
    expect(drivenUrlIn('operate_start', { url: 'javascript:alert(1)' })).toBe(undefined);
    expect(drivenUrlIn('operate_start', { url: 'https://user:pw@provider.test/login' })).toBe(
      undefined,
    );
  });
});

describe('resource MCP transport authorization', () => {
  it('extracts Squire approval URLs and purchase context from the MCP result', () => {
    const request = {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'inject_card',
        arguments: {
          item: 'Noise-cancelling headphones',
          merchant: 'Acme',
          amount_cents: 19_900,
          currency: 'usd',
          card_ref: 'opaque-card-ref',
        },
      },
    };
    const response = {
      jsonrpc: '2.0',
      id: 7,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'approval_pending',
              approval_id: 'purchase-7',
              approval_url: 'https://approve.trustysquire.test/approval/purchase-7',
            }),
          },
        ],
      },
    };
    expect(squireApprovalFromMcp(request, response)).toEqual({
      tool: 'inject_card',
      title: 'Purchase approval',
      detail: 'Noise-cancelling headphones · at Acme · 199.00 USD',
      approvalId: 'purchase-7',
      approvalUrl: 'https://approve.trustysquire.test/approval/purchase-7',
      linkKind: 'approval',
    });
  });

  it('relays passkey and vouch links while keeping credential copy free of secret fields', () => {
    expect(
      squireApprovalFromMcp(
        {
          id: 'fetch',
          method: 'tools/call',
          params: {
            name: 'fetch_credential',
            arguments: { service: 'OpenAI', reason: 'rotate deployment', secret: 'do-not-copy' },
          },
        },
        {
          id: 'fetch',
          result: {
            structuredContent: {
              state: 'passkey_required',
              passkey_url: 'https://trustysquire.test/passkey/fetch',
            },
          },
        },
      ),
    ).toEqual({
      tool: 'fetch_credential',
      title: 'Credential access approval',
      detail: 'Reveal OpenAI · rotate deployment',
      approvalUrl: 'https://trustysquire.test/passkey/fetch',
      linkKind: 'passkey',
    });
    expect(
      squireApprovalFromMcp(
        { id: 9, method: 'tools/call', params: { name: 'operate_login', arguments: {} } },
        {
          id: 9,
          result: {
            content: [{ type: 'text', text: 'Continue at https://trustysquire.test/vouch/9' }],
          },
        },
      )?.linkKind,
    ).toBe('vouch');
    expect(squireApprovalCopy('delete_credential', { name: 'Stripe' })).toEqual({
      title: 'Credential deletion approval',
      detail: 'Delete Stripe',
    });
  });

  it('ignores ordinary Squire results and unsafe approval destinations', () => {
    const request = {
      id: 1,
      method: 'tools/call',
      params: { name: 'list_credentials', arguments: {} },
    };
    expect(
      squireApprovalFromMcp(request, {
        id: 1,
        result: { content: [{ type: 'text', text: '[]' }] },
      }),
    ).toBeUndefined();
    expect(
      squireApprovalFromMcp(request, {
        id: 1,
        result: { structuredContent: { approval_url: 'javascript:alert(1)' } },
      }),
    ).toBeUndefined();
  });

  it('correlates a browser approval with its navigation, then clears it for unrelated calls', async () => {
    const root = await mkdtemp('/tmp/squire-approval-facade-test-');
    const context = join(root, 'turn.json');
    const auth = join(root, 'auth.json');
    const upstream = join(root, 'squire.cjs');
    await writeFile(
      upstream,
      `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const m=JSON.parse(line);
        if(m.id===undefined) return;
        const result=m.method==='tools/call' && m.params?.name!=='operate_login'
          ? {content:[{type:'text',text:JSON.stringify({status:'approval_pending',approval_id:'buy-'+m.id,approval_url:'https://approve.trustysquire.test/approval/buy-'+m.id})}]}
          : {};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
      });`,
    );
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push({ url: req.url ?? '', body: parsed });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          req.url?.endsWith('/authorizeResourceCall') ? { allowed: true } : { id: 'message' },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    await writeFile(
      auth,
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        daemonToken: 'test-token',
        turnContextPath: context,
      }),
    );
    await writeFile(
      context,
      JSON.stringify({ roomId: 'room', requestId: 'owner-turn', generationId: 'generation' }),
    );
    const child = spawn(process.execPath, resourceFacadeArgs(), {
      env: {
        ...process.env,
        BEELINE_RESOURCE_TARGET: 'squire',
        BEELINE_RESOURCE_AUTH_FILE: auth,
        BEELINE_RESOURCE_LAUNCH: JSON.stringify({ command: process.execPath, args: [upstream] }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const replies: Array<Record<string, unknown>> = [];
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => replies.push(JSON.parse(line)));
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'operate_login',
            arguments: { url: 'https://mcp.linear.app/authorize?state=old-attempt' },
          },
        })}\n`,
      );
      await vi.waitFor(() => expect(replies.some((reply) => reply.id === 1)).toBe(true), {
        timeout: 5000,
      });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'operate_click', arguments: { ref: 'approval-button' } },
        })}\n`,
      );
      await vi.waitFor(() => expect(replies.some((reply) => reply.id === 2)).toBe(true), {
        timeout: 5000,
      });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'inject_card',
            arguments: {
              item: 'Headphones',
              merchant: 'Acme',
              amount_cents: 19_900,
              currency: 'usd',
            },
          },
        })}\n`,
      );
      await vi.waitFor(() => expect(replies.some((reply) => reply.id === 3)).toBe(true), {
        timeout: 5000,
      });
      expect(requests.map((request) => request.url)).toEqual([
        '/v1/daemon/operations/authorizeResourceCall',
        '/v1/daemon/operations/authorizeResourceCall',
        '/v1/daemon/operations/postSquireApproval',
        '/v1/daemon/operations/authorizeResourceCall',
        '/v1/daemon/operations/postSquireApproval',
      ]);
      expect(requests[2]?.body.signInUrl).toBe(
        'https://mcp.linear.app/authorize?state=old-attempt',
      );
      expect(requests[4]?.body).toMatchObject({
        roomId: 'room',
        requestId: 'owner-turn',
        tool: 'inject_card',
        title: 'Purchase approval',
        detail: 'Headphones · at Acme · 199.00 USD',
        approvalUrl: 'https://approve.trustysquire.test/approval/buy-3',
      });
      expect(requests[4]?.body.signInUrl).toBeUndefined();
    } finally {
      lines.close();
      child.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['stdio', 'http'])(
    'checks each %s paid call even without harness callbacks',
    async (transport) => {
      const root = await mkdtemp('/tmp/resource-facade-test-');
      const context = join(root, 'turn.json');
      const auth = join(root, 'auth.json');
      const upstream = join(root, 'upstream.cjs');
      const started = join(root, 'started');
      await writeFile(
        upstream,
        `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started');
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:999,result:{secret:true}})+'\\n');
    let count=0; require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line); if(m.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{count:++count}})+'\\n');
    });`,
      );
      const requests: Array<Record<string, unknown>> = [];
      let unavailable = false;
      let httpCalls = 0;
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (req.url === '/resource') {
          if (httpCalls) expect(req.headers['mcp-session-id']).toBe('resource-session');
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'resource-session',
          });
          res.end(
            `data: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: { secret: true } })}\n\n` +
              `data: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { count: ++httpCalls } })}\n\n`,
          );
          return;
        }
        requests.push(parsed);
        expect(req.url).toBe('/v1/daemon/operations/authorizeResourceCall');
        expect(req.headers.authorization).toBe('Bearer test-token');
        res.writeHead(unavailable ? 503 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ allowed: parsed.requestId === 'owner-turn' }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as { port: number };
      await writeFile(
        auth,
        JSON.stringify({
          baseUrl: `http://127.0.0.1:${address.port}`,
          daemonToken: 'test-token',
          turnContextPath: context,
        }),
      );
      await writeFile(
        context,
        JSON.stringify({
          roomId: 'room',
          requestId: 'third-party-turn',
          generationId: 'generation',
        }),
      );
      const route = rewriteHostMcpDeclaration(
        'paid-api',
        transport === 'stdio'
          ? { command: process.execPath, args: [upstream] }
          : { url: `http://127.0.0.1:${address.port}/resource` },
        root,
        auth,
      );
      expect(route.args).toEqual(resourceFacadeArgs());
      const child = spawn(String(route.command), route.args as string[], {
        env: { ...process.env, ...(route.env as Record<string, string>) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const replies: Array<{ id: number; result?: { count: number }; error?: { code: number } }> =
        [];
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => replies.push(JSON.parse(line)));
      const call = async (id: number, method = 'tools/call') => {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params: { name: 'paid_call', arguments: {} } })}\n`,
        );
        await vi.waitFor(() => expect(replies.some((r) => r.id === id)).toBe(true), {
          timeout: 5000,
        });
        return replies.find((r) => r.id === id)!;
      };
      try {
        expect(existsSync(started)).toBe(false);
        expect((await call(1, 'tools/list')).error?.code).toBe(-32001);
        expect(existsSync(started)).toBe(false);
        expect(httpCalls).toBe(0);
        await writeFile(
          context,
          JSON.stringify({
            roomId: 'room',
            requestId: 'owner-turn',
            generationId: 'generation',
          }),
        );
        expect((await call(2, 'initialize')).result?.count).toBe(1);
        expect((await call(3, 'tools/list')).result?.count).toBe(2);
        expect((await call(4)).result?.count).toBe(3);
        expect(requests.map((r) => r.requestId)).toEqual([
          'third-party-turn',
          'owner-turn',
          'owner-turn',
          'owner-turn',
        ]);
        expect(requests.every((r) => r.target === 'paid-api')).toBe(true);
        expect(requests.slice(0, 3).every((r) => r.consume === false)).toBe(true);
        expect(requests[3]).not.toHaveProperty('consume');
        expect(replies.some((reply) => reply.id === 999)).toBe(false);
        await writeFile(
          context,
          JSON.stringify({
            roomId: 'room',
            requestId: 'third-party-turn',
            generationId: 'generation',
          }),
        );
        expect((await call(5)).error?.code).toBe(-32001);
        await writeFile(context, '{}');
        expect((await call(6)).error?.code).toBe(-32001);
        expect(requests).toHaveLength(5);
        await writeFile(
          context,
          JSON.stringify({ roomId: 'room', requestId: 'owner-turn', generationId: 'generation' }),
        );
        unavailable = true;
        expect((await call(7)).error?.code).toBe(-32001);
        unavailable = false;
        // No rejected call or unsolicited response reached the resource/client boundary.
        expect((await call(8)).result?.count).toBe(4);
      } finally {
        lines.close();
        child.kill();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
