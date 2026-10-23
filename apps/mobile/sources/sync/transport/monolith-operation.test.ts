import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: { fetch: controls.fetch },
  MONOLITH_REQUEST_TIMEOUT_MS: 15_000,
  MonolithRequestTimeoutError: class extends Error { constructor() { super('The result is unknown. Refresh to check before trying again.'); } },
}));

import { monolithPhoneOperation, phoneOperationFailureReason } from './monolith-operation';

describe('monolith phone operation', () => {
  beforeEach(() => controls.fetch.mockReset());

  it('treats a successful no-content response as a void operation result', async () => {
    controls.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(monolithPhoneOperation('sendPushTest', {})).resolves.toBeUndefined();
    expect(controls.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/operations/sendPushTest',
      expect.objectContaining({ method: 'POST', body: '{}' }),
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
  });

  it("carries a refusal's own reason out to the caller that has to show it", async () => {
    controls.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'host MCP is only for an agent that answers its owner' }),
        {
          status: 403,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const failure = await monolithPhoneOperation('decideAgentGrant', {
      grantId: 'grant-1',
      decision: 'always',
    }).catch((error: unknown) => error);

    expect(phoneOperationFailureReason(failure)).toBe(
      'host MCP is only for an agent that answers its owner',
    );
  });
});

// Read the server's actual registry, so adding an operation automatically adds
// a stalled-transport case without maintaining a second list.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { phoneOperationRequestOptions } from './monolith-operation';
const serviceSource = ts.createSourceFile('phone-service.ts', readFileSync(
  new URL('../../../../server/src/phone-service.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const registry = serviceSource.statements.find((node) => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some((item) => item.name.getText(serviceSource) === 'PHONE_OPERATION_NAMES')) as ts.VariableStatement;
const initializer = registry.declarationList.declarations[0]!.initializer as ts.NewExpression;
const operationNames = (initializer.arguments![0] as ts.ArrayLiteralExpression).elements.map(
  (node) => (node as ts.StringLiteral).text as keyof PhoneOperationMap);

describe('every registered phone operation has a complete deadline', () => {
  afterEach(() => vi.useRealTimers());
  it('discovers the registry rather than testing a hand list', () => expect(operationNames.length).toBeGreaterThan(100));
  it.each(operationNames)('%s leaves a transport that never answers', async (name) => {
    vi.useFakeTimers();
    controls.fetch.mockImplementation(() => new Promise(() => {}));
    const result = monolithPhoneOperation(name, {} as never).catch((error: unknown) => error);
    const limit = phoneOperationRequestOptions(name, {})?.timeoutMs;
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(name === 'actOnRepositoryCard' ? 60_000 : 20_000);
    await vi.advanceTimersByTimeAsync(limit!);
    expect(await result).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves an explicit longer deadline for a slow transaction', async () => {
    vi.useFakeTimers();
    controls.fetch.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const result = monolithPhoneOperation('deleteWorkspace', { workspaceId: 'w' }, { timeoutMs: 40_000 })
      .catch((error: unknown) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toBeInstanceOf(Error);
  });
  it('also bounds a body that never arrives after successful headers', async () => {
    vi.useFakeTimers();
    controls.fetch.mockResolvedValue({ok: true, status: 200, json: () => new Promise(() => {})});
    const result = monolithPhoneOperation('resolveDirectMessage', { workspaceId: 'w', participantId: 'p' }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toBeInstanceOf(Error);
  });
});
