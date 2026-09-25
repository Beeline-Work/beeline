import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, it, expect, vi } from 'vitest';
import {
  resourceFacadeArgs,
  squireApprovalCopy,
  squireApprovalFromMcp,
} from './resource-mcp-facade.js';
import { rewriteHostMcpDeclaration } from './host-mcp-route.js';

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

  it('posts a Squire approval before returning its pending result to the client', async () => {
    const root = await mkdtemp('/tmp/squire-approval-facade-test-');
    const context = join(root, 'turn.json');
    const auth = join(root, 'auth.json');
    const upstream = join(root, 'squire.cjs');
    await writeFile(
      upstream,
      `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const m=JSON.parse(line);
        if(m.id===undefined) return;
        const result=m.method==='tools/call'
          ? {content:[{type:'text',text:JSON.stringify({status:'approval_pending',approval_id:'buy-1',approval_url:'https://approve.trustysquire.test/approval/buy-1'})}]}
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
      await vi.waitFor(() => expect(replies.some((reply) => reply.id === 1)).toBe(true), {
        timeout: 5000,
      });
      expect(requests.map((request) => request.url)).toEqual([
        '/v1/daemon/operations/authorizeResourceCall',
        '/v1/daemon/operations/postSquireApproval',
      ]);
      expect(requests[1]?.body).toMatchObject({
        roomId: 'room',
        requestId: 'owner-turn',
        tool: 'inject_card',
        title: 'Purchase approval',
        detail: 'Headphones · at Acme · 199.00 USD',
        approvalUrl: 'https://approve.trustysquire.test/approval/buy-1',
      });
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
      await writeFile(
        upstream,
        `let count=0; require('node:readline').createInterface({input:process.stdin}).on('line', line => {
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
        JSON.stringify({ roomId: 'room', requestId: 'owner-turn', generationId: 'generation' }),
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
        expect((await call(1, 'tools/list')).result?.count).toBe(1);
        expect(requests).toEqual([]);
        expect((await call(2)).result?.count).toBe(2);
        await writeFile(
          context,
          JSON.stringify({
            roomId: 'room',
            requestId: 'third-party-turn',
            generationId: 'generation',
          }),
        );
        expect((await call(3)).error?.code).toBe(-32001);
        expect(requests.map((r) => r.requestId)).toEqual(['owner-turn', 'third-party-turn']);
        expect(requests.every((r) => r.target === 'paid-api')).toBe(true);
        await writeFile(context, '{}');
        expect((await call(4)).error?.code).toBe(-32001);
        expect(requests).toHaveLength(2);
        await writeFile(
          context,
          JSON.stringify({ roomId: 'room', requestId: 'owner-turn', generationId: 'generation' }),
        );
        unavailable = true;
        expect((await call(5)).error?.code).toBe(-32001);
        unavailable = false;
        // No rejected call reached the resource, so this is the third upstream request.
        expect((await call(6)).result?.count).toBe(3);
      } finally {
        lines.close();
        child.kill();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
