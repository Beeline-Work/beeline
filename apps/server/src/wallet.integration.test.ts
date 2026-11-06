import { phoneFetch, generateKeyPairSync, CdpWalletClient, WalletTransactionPending, describe, expect, it, vi, walletSource, walletExplorerTxUrl, SYSTEM_IDENTITY_ID, PushDeliveryLoop, postWalletNotice, HUMAN, HELPER, ROOM, WALLET_REQUEST, WORKSPACE, BRIDGE2, fixtureScope1, type WalletNotice, type CdpWalletSourceLike } from './test-support-wallet.integration.test-support.js';

describe('wallet over the fake CDP seam', () => {
const scope1 = fixtureScope1();


  it('wallet-503: owned agent reads resolve its wallet and Workbench follows signing delegation', async () => {
    const wallet = await scope1.createdWallet();
    const readCatalog = async () => (await scope1.daemonOperation('readAgentWorkbench', {})).body.catalog as Array<{ connectorType: string; paired?: { status: string } }>;
    expect((await readCatalog()).find((entry) => entry.connectorType === 'wallet')?.paired).toBeUndefined();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    for (const name of ['getWalletToolState', 'getWalletToolChains', 'getWalletToolBalance']) {
      const result = await scope1.daemonOperation(name, { agentId: HELPER });
      expect(result.status).toBe(200);
      if (name === 'getWalletToolState') expect(result.body.wallet).toMatchObject({ address: wallet.address });
    }
    expect((await readCatalog()).find((entry) => entry.connectorType === 'wallet')?.paired).toMatchObject({ status: 'connected', onThisMachine: true });
    for (const agentId of ['self', 'f'.repeat(64)]) {
      const result = await scope1.daemonOperation('getWalletToolState', { agentId });
      expect(result.status).toBe(503);
      expect(result.body.error).toBe('daemon token does not own requested agent');
    }
    await scope1.database.query(`UPDATE wallet_bindings SET delegation_standing=false,delegation_expires_at=NULL WHERE identity_id=$1`, [HUMAN]);
    expect((await readCatalog()).find((entry) => entry.connectorType === 'wallet')?.paired).toBeUndefined();
  });


  it.each(['standing', 'timed'])('wallet-2593: owner disconnect revokes %s signing without deleting the wallet or history', async (kind) => {
    const wallet = await scope1.createdWallet();
    try {
      await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
      if (kind === 'timed') await scope1.database.query(
        `UPDATE wallet_bindings SET delegation_standing=false,delegation_expires_at=now()+interval '1 day' WHERE identity_id=$1`, [HUMAN]);
      const input = { agentId: HELPER, ...scope1.harmlessTypedData };
      expect((await scope1.daemonOperation('walletSignTypedData', input)).body.outcome).toBe('signed');
      const foreignToken = (await scope1.auth.exchangeGitHubOidc('outsider')).accessToken;
      const foreignRevoke = await phoneFetch(`${scope1.origin}/v1/phone/operations/revokeWalletDelegation`, {
        method: 'POST', headers: { authorization: `Bearer ${foreignToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ identityId: HUMAN }),
      });
      expect([200, 204]).toContain(foreignRevoke.status);
      expect(await scope1.phoneOperation('readWallet', {})).toMatchObject({ delegation: { active: true } });
      const sign = vi.spyOn(walletSource(), 'signTypedData');
      scope1.fundChain(wallet.address, 'base', 'usdc', 10);
      scope1.fundChain(wallet.address, 'base', 'eth', 1);
      expect(await scope1.phoneOperation('sendFromWallet', { workspaceId: WORKSPACE, chain: 'base', asset: 'usdc', amount: '1', to: `0x${'a'.repeat(40)}` })).toMatchObject({ outcome: 'sent' });
      await scope1.phoneOperation('readWallet', {});
      const before = await scope1.phoneOperation('readWalletHistory', {});
      expect(before).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ direction: 'out' })]) });
      // A supplied identity cannot redirect the authenticated owner's revocation.
      await scope1.phoneOperation('revokeWalletDelegation', { identityId: HELPER });
      await scope1.phoneOperation('revokeWalletDelegation', {});
      expect((await scope1.phoneOperation('readWallet', {}))).toMatchObject({ address: wallet.address, delegation: { active: false, expiresAt: null } });
      expect(await scope1.phoneOperation('readWalletHistory', {})).toEqual(before);
      expect((await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }))).toMatchObject({ wallet: { delegationActive: false, delegationExpiresAt: null } });
      expect((await scope1.daemonOperation('walletSignTypedData', input)).body.outcome).toBe('delegation-expired');
      expect(sign).not.toHaveBeenCalled();
      expect((await scope1.daemonOperation('walletPay', { agentId: HELPER, chain: 'base', asset: 'usdc', amount: '1', to: '0xabc' })).body.outcome).toBe('delegation-expired');
      const catalog = (await scope1.daemonOperation('readAgentWorkbench', {})).body.catalog as Array<{ connectorType: string; paired?: unknown }>;
      expect(catalog.find(entry => entry.connectorType === 'wallet')?.paired).toBeUndefined();
      await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
      expect((await scope1.daemonOperation('walletSignTypedData', input)).body.outcome).toBe('signed');
    } finally {
      scope1.fakeState().holdings.clear();
      scope1.fakeState().transactions.clear();
    }
  });


  it('signs harmless Exchange chainId 1337 data only with live delegation and records a signature audit', async () => {
    const wallet = await scope1.createdWallet();
    const source = walletSource();
    const sign = vi.spyOn(source, 'signTypedData');
    const input = { agentId: HELPER, ...scope1.harmlessTypedData };
    expect((await scope1.daemonOperation('walletSignTypedData', input)).body.outcome).toBe('delegation-expired');
    expect(sign).not.toHaveBeenCalled();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const result = await scope1.daemonOperation('walletSignTypedData', input);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ outcome: 'signed', signature: expect.stringMatching(/^0x[a-f0-9]{130}$/) });
    expect(sign).toHaveBeenCalledWith(wallet.address, scope1.harmlessTypedData);
    const audit = (await scope1.database.query<{ card: Record<string, unknown>; text: string }>(
      `SELECT card,text FROM messages WHERE card_type='wallet-signature'`,
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.card).toMatchObject({ agentId: HELPER, address: wallet.address, domain: scope1.harmlessTypedData.domain, primaryType: 'BeelineTest', payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(audit[0]!.card).not.toHaveProperty('signature');
    expect(audit[0]!.text).toContain('signed EIP-712 typed data');
    expect((await scope1.database.query('SELECT id FROM wallet_transactions')).rows).toHaveLength(0);
    expect((await scope1.daemonOperation('getWalletToolBalance', { agentId: HELPER })).body.totalUsd).toBe('$0.00');
    await scope1.database.query(`UPDATE wallet_bindings SET delegation_standing=false,delegation_expires_at=NULL WHERE identity_id=$1`, [HUMAN]);
    expect((await scope1.daemonOperation('walletSignTypedData', input)).body.outcome).toBe('delegation-expired');
    expect(sign).toHaveBeenCalledTimes(1);
  });


  it('holds typed-data signing for third-party requesters, consumes once approval and rejects foreign agents', async () => {
    await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const requester = 'c'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Requester')`, [requester]);
    await scope1.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WORKSPACE, requester, ROOM]);
    await scope1.database.query(`UPDATE messages SET author_id=$2 WHERE id=$1`, [WALLET_REQUEST, requester]);
    const sign = vi.spyOn(walletSource(), 'signTypedData');
    const input = { agentId: HELPER, ...scope1.harmlessTypedData };
    const pending = await scope1.daemonOperation('walletSignTypedData', input);
    expect(pending.body.status).toBe('permission-required');
    expect(sign).not.toHaveBeenCalled();
    const grant = (await scope1.database.query<{ command_id: string; requested_by: string }>(`SELECT command_id,requested_by FROM agent_grants WHERE id=$1`, [pending.body.grantId])).rows[0]!;
    expect(grant.command_id).toBeTruthy();
    expect(grant.requested_by).toBe(requester);
    await scope1.phoneOperation('decideAgentGrant', { grantId: pending.body.grantId, decision: 'once' });
    expect((await scope1.daemonOperation('walletSignTypedData', input)).body.outcome).toBe('signed');
    expect((await scope1.daemonOperation('walletSignTypedData', input)).body.status).toBe('permission-required');
    expect((await scope1.daemonOperation('walletSignTypedData', { ...input, agentId: 'f'.repeat(64) })).status).toBe(503);
    expect(sign).toHaveBeenCalledTimes(1);
  });


  it('rejects malformed typed data and reports provider refusals without recording success', async () => {
    await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const sign = vi.spyOn(walletSource(), 'signTypedData').mockRejectedValue(new Error('CDP policy refused chainId 1337'));
    for (const bad of [{ domain: null }, { types: [] }, { message: [] }, { primaryType: 'Missing' }, { types: { BeelineTest: [{}] } }]) {
      expect((await scope1.daemonOperation('walletSignTypedData', { agentId: HELPER, ...scope1.harmlessTypedData, ...bad })).body).toMatchObject({ outcome: 'failed', reason: 'invalid EIP-712 typed data' });
    }
    expect(sign).not.toHaveBeenCalled();
    for (const roomInput of [{}, { roomId: ROOM }]) {
      const response = await phoneFetch(`${scope1.origin}/v1/daemon/operations/walletSignTypedData`, {
        method: 'POST', headers: { authorization: `Bearer ${scope1.helperToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: HELPER, ...scope1.harmlessTypedData, ...roomInput }),
      });
      expect(response.ok).toBe(false);
    }
    expect(sign).not.toHaveBeenCalled();
    expect((await scope1.daemonOperation('walletSignTypedData', { agentId: HELPER, ...scope1.harmlessTypedData })).body).toEqual({ outcome: 'failed', reason: 'CDP policy refused chainId 1337' });
    expect((await scope1.database.query(`SELECT id FROM messages WHERE card_type='wallet-signature'`)).rows).toHaveLength(0);
  });


  it('one tap creates the wallet bound to the signed-in identity', async () => {
    const view = await scope1.createdWallet();
    expect(view.address).toMatch(/^0x/);
    const again = (await scope1.phoneOperation('createWallet', { workspaceId: WORKSPACE })) as {
      address: string;
    };
    expect(again.address).toBe(view.address);

    const emptyChats = (await (
      await phoneFetch(`${scope1.origin}/v1/phone/workspaces/${WORKSPACE}/chats`, {
        headers: { authorization: `Bearer ${scope1.accessToken}` },
      })
    ).json()) as { chats: Array<{ directMessage?: { peer: { handle?: string } } }> };
    expect(emptyChats.chats.some((chat) => chat.directMessage?.peer.handle === 'system')).toBe(
      true,
    );

    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE, ttlHours: 24 });
    const chats = (await (
      await phoneFetch(`${scope1.origin}/v1/phone/workspaces/${WORKSPACE}/chats`, {
        headers: { authorization: `Bearer ${scope1.accessToken}` },
      })
    ).json()) as {
      chats: Array<{
        latestMessage?: { text: string };
        directMessage?: { peer: { name: string; handle?: string; avatar?: string } };
      }>;
    };
    const wallet = chats.chats.find((chat) => chat.directMessage?.peer.handle === 'system');
    expect(wallet?.directMessage?.peer).toMatchObject({
      name: 'System',
      handle: 'system',
      avatar: 'http://placeholder/v1/connectors/logo/system.svg',
    });
    expect(wallet?.latestMessage?.text).toContain('granted agents permission to sign');
  });


  it('rejects missing, malformed, and inaccessible grant Workspaces before changing expiry', async () => {
    await scope1.createdWallet();
    await scope1.database.query(
      `UPDATE wallet_bindings SET delegation_expires_at=now() - interval '1 hour' WHERE identity_id=$1`,
      [HUMAN],
    );
    expect(
      (
        (await scope1.phoneOperation('readWallet', { workspaceId: '' })) as {
          delegation: { active: boolean };
        }
      ).delegation.active,
    ).toBe(false);
    const otherWorkspace = '33333333-3333-4333-8333-333333333333';
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other')`, [otherWorkspace]);
    for (const [payload, expected] of [
      [{}, 'valid Workspace ID required'],
      [{ workspaceId: '' }, 'valid Workspace ID required'],
      [{ workspaceId: 'not-a-uuid' }, 'valid Workspace ID required'],
      [{ workspaceId: otherWorkspace }, 'workspace membership required'],
    ] as const) {
      const response = await phoneFetch(`${scope1.origin}/v1/phone/operations/grantWalletDelegation`, {
        method: 'POST',
        headers: { authorization: `Bearer ${scope1.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(expected);
      const expiry = (
        await scope1.database.query<{ active: boolean }>(
          `SELECT delegation_expires_at > now() AS active FROM wallet_bindings WHERE identity_id=$1`,
          [HUMAN],
        )
      ).rows[0];
      expect(expiry?.active).toBe(false);
    }
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    expect(
      (
        (await scope1.phoneOperation('readWallet', { workspaceId: '' })) as {
          delegation: { active: boolean };
        }
      ).delegation.active,
    ).toBe(true);
    const expiry = (
      await scope1.database.query<{ active: boolean; expires_at: Date | null }>(
        `SELECT delegation_standing AS active,delegation_expires_at AS expires_at FROM wallet_bindings WHERE identity_id=$1`,
        [HUMAN],
      )
    ).rows[0];
    expect(expiry?.active).toBe(true);
    expect(expiry?.expires_at).toBeNull();
  });


  it('distinguishes never granted, legacy timed, expired, standing, and revoked states', async () => {
    await scope1.createdWallet();
    const read = async () =>
      (await scope1.phoneOperation('readWallet', { workspaceId: WORKSPACE })) as {
        delegation: { active: boolean; expiresAt: number | null };
      };
    expect((await read()).delegation).toEqual({ active: false, expiresAt: null });

    const legacyExpiry = new Date(Date.now() + 3_600_000);
    await scope1.database.query(
      `UPDATE wallet_bindings SET delegation_expires_at=$2 WHERE identity_id=$1`,
      [HUMAN, legacyExpiry],
    );
    expect((await read()).delegation).toEqual({ active: true, expiresAt: legacyExpiry.getTime() });
    await scope1.database.query(
      `UPDATE wallet_bindings SET delegation_expires_at=now() - interval '1 hour' WHERE identity_id=$1`,
      [HUMAN],
    );
    expect((await read()).delegation.active).toBe(false);

    expect(await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE })).toEqual({
      expiresAt: null,
    });
    expect((await read()).delegation).toEqual({ active: true, expiresAt: null });
    const grantCard = (
      await scope1.database.query<{ text: string; card: { standing: boolean } }>(
        `SELECT text,card FROM messages WHERE card_type='wallet-delegation' ORDER BY created_at DESC LIMIT 1`,
      )
    ).rows[0];
    expect(grantCard?.text).toContain('until revoked');
    expect(grantCard?.card).toEqual({ standing: true });
    const workbench = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      wallet: { delegationActive: boolean; delegationExpiresAt: number | null };
    };
    expect(workbench.wallet).toMatchObject({ delegationActive: true, delegationExpiresAt: null });
    await scope1.database.query(
      `UPDATE wallet_bindings SET delegation_standing=false WHERE identity_id=$1`,
      [HUMAN],
    );
    expect((await read()).delegation).toEqual({ active: false, expiresAt: null });
    expect(
      (
        (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
          wallet: { delegationActive: boolean };
        }
      ).wallet.delegationActive,
    ).toBe(false);
    expect(
      (
        await scope1.daemonOperation('walletPay', {
          agentId: HELPER,
          chain: 'base',
          asset: 'usdc',
          amount: '1',
          to: '0xabc',
        })
      ).body.outcome,
    ).toBe('delegation-expired');
  });


  it('a wallet offer card connects the wallet when its addressee accepts', async () => {
    const offered = await scope1.daemonOperation('offerConnector', {
      connectorType: 'wallet',
      reason: 'pay the hosting invoice',
    });
    expect(offered.status).toBe(200);
    const offerId = offered.body.offerId as string;
    const pending = await scope1.database.query<{ card: Record<string, any> }>(
      `SELECT card FROM messages WHERE card_type='connector-offer'`,
    );
    expect(pending.rows[0]!.card).toMatchObject({
      offerId,
      connectorType: 'wallet',
      status: 'pending',
      consequence:
        'This changes your Connectors. Once it is added, I can pay the hosting invoice — you can revoke permission any time',
    });

    // A Workspace admin who is not the addressee cannot grant someone else's wallet.
    const adminToken = (await scope1.auth.exchangeGitHubOidc('mara')).accessToken;
    const admin = (
      await scope1.database.query<{ id: string }>(`SELECT id FROM identities WHERE github_subject='mara'`)
    ).rows[0]!;
    await scope1.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'admin')`,
      [WORKSPACE, admin.id],
    );
    const refused = await phoneFetch(`${scope1.origin}/v1/phone/operations/acceptConnectorOffer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ offerId }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'Only the person the agent addressed can connect their own wallet',
    });
    expect(
      (await scope1.database.query(`SELECT 1 FROM wallet_bindings WHERE identity_id=$1`, [HUMAN]))
        .rowCount,
    ).toBe(0);

    // The addressee accepts: that tap creates the wallet and grants agents
    // permission to sign, and the card settles without a helper ceremony.
    expect(await scope1.phoneOperation('acceptConnectorOffer', { offerId })).toEqual({
      offerId,
      status: 'accepted',
      roomId: ROOM,
    });
    const binding = await scope1.database.query<{ delegation_standing: boolean }>(
      `SELECT delegation_standing FROM wallet_bindings WHERE identity_id=$1`,
      [HUMAN],
    );
    expect(binding.rows[0]?.delegation_standing).toBe(true);
    const settled = await scope1.database.query<{ card: Record<string, any> }>(
      `SELECT card FROM messages WHERE card_type='connector-offer'`,
    );
    expect(settled.rows[0]!.card).toMatchObject({ status: 'accepted', acceptedAt: expect.any(Number) });
    expect(settled.rows[0]!.card.acceptedBy.pubkey).toBe(HUMAN);
    const decision = await scope1.database.query<{ card: Record<string, any> }>(
      `SELECT card FROM messages WHERE card_type='connector-offer-decision'`,
    );
    expect(decision.rows.map((row) => row.card)).toEqual([{ offerId, status: 'accepted' }]);

    // A connected wallet is not offered again.
    const again = await scope1.daemonOperation('offerConnector', {
      connectorType: 'wallet',
      reason: 'pay the hosting invoice',
    });
    expect(again.status).toBe(409);
  });


  it('a failing history read does not break createWallet or readWallet', async () => {
    // The real CDP v2 history endpoint is unconfirmed (it 401s/404s); the
    // wallet must be fully usable — address + balances — regardless.
    const source = walletSource() as CdpWalletSourceLike & {
      history: (address: string, limit: number) => Promise<never>;
    };
    const originalHistory = source.history.bind(source);
    source.history = () => Promise.reject(new Error('CDP GET .../transfers failed (401)'));
    try {
      const view = (await scope1.phoneOperation('createWallet', { workspaceId: WORKSPACE })) as {
        address: string;
        totalUsd: string;
      };
      expect(view.address).toMatch(/^0x/);
      const read = (await scope1.phoneOperation('readWallet', { workspaceId: WORKSPACE })) as {
        address: string;
        totalUsd: string;
      };
      expect(read.address).toBe(view.address);
      expect(typeof read.totalUsd).toBe('string');
    } finally {
      source.history = originalHistory;
    }
  });


  it('holds third-party paid calls for the wallet owner and sends only after scoped approval', async () => {
    await scope1.createdWallet();
    scope1.fakeState().holdings.forEach((holdings) => holdings.set('usdc', 500));
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE, ttlHours: 24 });
    const requester = 'c'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Requester')`, [
      requester,
    ]);
    await scope1.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, requester, ROOM],
    );
    await scope1.database.query(`UPDATE messages SET author_id=$2 WHERE id=$1`, [
      WALLET_REQUEST,
      requester,
    ]);
    const payment = { agentId: HELPER, chain: 'base', asset: 'usdc', amount: '120', to: '0xabc' };
    const before = (await scope1.phoneOperation('readWallet', { workspaceId: WORKSPACE })) as {
      totalUsd: string;
    };
    const pending = await scope1.daemonOperation('walletPay', payment);
    expect(pending.body.status).toBe('permission-required');
    const unchanged = (await scope1.phoneOperation('readWallet', { workspaceId: WORKSPACE })) as {
      totalUsd: string;
    };
    expect(unchanged.totalUsd).toBe(before.totalUsd);
    const grant = (
      await scope1.database.query<{ requested_by: string; command_id: string }>(
        `SELECT requested_by,command_id FROM agent_grants WHERE id=$1`,
        [pending.body.grantId],
      )
    ).rows[0]!;
    expect(grant.requested_by).toBe(requester);
    expect(grant.command_id).toBeTruthy();
    await scope1.phoneOperation('decideAgentGrant', { grantId: pending.body.grantId, decision: 'once' });
    expect((await scope1.daemonOperation('walletPay', payment)).body.outcome).toBe('sent');
    expect((await scope1.daemonOperation('walletPay', payment)).body.status).toBe('permission-required');
    expect((await scope1.database.query(`SELECT id FROM agent_grants WHERE kind='budget'`)).rows).toEqual(
      [],
    );
  });


  it('an agent pay is refused without a live delegation, then lands and posts one ledger card', async () => {
    const view = await scope1.createdWallet();
    // Fund the fake: 500 USDC.
    scope1.fakeState().holdings.forEach((holdings) => holdings.set('usdc', 500));

    const refused = (await scope1.daemonOperation('walletPay', {
      agentId: HELPER,
      chain: 'base',
      asset: 'usdc',
      amount: '120',
      to: '0xabc',
    })) as { body: { outcome: string } };
    expect(refused.body.outcome).toBe('delegation-expired');

    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE, ttlHours: 24 });

    const sent = (await scope1.daemonOperation('walletPay', {
      agentId: HELPER,
      chain: 'base',
      asset: 'usdc',
      amount: '120',
      to: '0xabc',
    })) as { body: { outcome: string; balanceAfterUsd: string } };
    expect(sent.body.outcome).toBe('sent');

    const after = (await scope1.phoneOperation('readWallet', { workspaceId: WORKSPACE })) as {
      totalUsd: string;
    };
    expect(after.totalUsd).toBe(view.totalUsd === '$0.00' ? '$380.00' : after.totalUsd);
  });


  it('a grant still authorizes agent send and swap after 24 hours', async () => {
    await scope1.createdWallet();
    scope1.fakeState().holdings.forEach((holdings) => holdings.set('usdc', 500));
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const grantedAt = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(grantedAt + 25 * 3_600_000);

    const pay = await scope1.daemonOperation('walletPay', {
      agentId: HELPER,
      chain: 'base',
      asset: 'usdc',
      amount: '10',
      to: '0xabc',
    });
    expect(pay.body.outcome).toBe('sent');

    const swap = await scope1.daemonOperation('walletSwap', {
      agentId: HELPER,
      chain: 'base',
      fromAsset: 'usdc',
      toAsset: 'eth',
      amount: '10',
    });
    expect(swap.body.outcome).toBe('sent');
  });



  it.each(['0x0', '0x1', null])('Reproduction swap-receipt-1: daemon reports receipt %s truthfully', async (receiptStatus) => {
    await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const key = generateKeyPairSync('ed25519').privateKey;
    const walletKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const client = new CdpWalletClient({ keyId: 'test',
      keySecret: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
      walletSecret: walletKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    const originalFetch = globalThis.fetch;
    let submissions = 0;
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
      if (String(url).startsWith(scope1.origin)) return originalFetch(url, options);
      if (String(url).endsWith('/evm/swaps')) return Response.json({
        toAmount: '43210000', transaction: { to: '0x2222222222222222222222222222222222222222', data: '0xabcd', gas: '420491' },
      });
      if (String(url).endsWith('/send/transaction')) {
        submissions += 1;
        return Response.json({ transactionHash: '0xreceiptproof' });
      }
      const entries = JSON.parse(String(options?.body)) as { id: number }[];
      return Response.json(entries.map(({ id }) => ({ jsonrpc: '2.0', id,
        result: receiptStatus === null ? null : { status: receiptStatus },
      })));
    });
    vi.spyOn(walletSource(), 'swap').mockImplementation(async (address, input) => {
      vi.useFakeTimers();
      try {
        const result = client.swap(address, input);
        const observed = result.then(value => ({ value }), error => ({ error }));
        await vi.runAllTimersAsync();
        const settled = await observed;
        if ('error' in settled) throw settled.error;
        return settled.value;
      } finally { vi.useRealTimers(); }
    });
    const before = (await scope1.database.query('SELECT * FROM wallet_transactions')).rows.length;
    const response = await scope1.daemonOperation('walletSwap', {
      agentId: HELPER, chain: 'arbitrum', fromAsset: 'eth', toAsset: 'usdc', amount: '0.017',
    });
    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe(receiptStatus === '0x0' ? 'failed' : receiptStatus === '0x1' ? 'sent' : 'pending');
    if (receiptStatus === '0x0') expect(response.body.reason).toContain('0xreceiptproof reverted');
    if (receiptStatus === null) expect(response.body.txUrl).toContain('0xreceiptproof');
    expect(submissions).toBe(1);
    const after = (await scope1.database.query('SELECT * FROM wallet_transactions')).rows.length;
    expect(after - before).toBe(receiptStatus === '0x1' ? 1 : 0);
    console.log(`Reproduction swap-receipt-1: daemon walletSwap receipt=${receiptStatus} outcome=${response.body.outcome}; submissions=${submissions}; ledger additions=${after - before}`);
    vi.unstubAllGlobals();
  });


  it('each phone send, agent pay, swap and contract call posts a linked owner-only @System notice', async () => {
    const wallet = await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    scope1.fundChain(wallet.address, 'base', 'usdc', 500);
    scope1.fundChain(wallet.address, 'base', 'eth', 1);
    const pay = { chain: 'base', asset: 'usdc', amount: '2', to: `0x${'7'.repeat(40)}` };
    expect(await scope1.phoneOperation('sendFromWallet', { ...pay, workspaceId: WORKSPACE })).toMatchObject({ outcome: 'sent' });
    expect((await scope1.daemonOperation('walletPay', { ...pay, agentId: HELPER })).body.outcome).toBe('sent');
    expect((await scope1.daemonOperation('walletSwap', {
      agentId: HELPER, chain: 'base', fromAsset: 'usdc', toAsset: 'eth', amount: '3',
    })).body.outcome).toBe('sent');
    expect((await scope1.daemonOperation('walletContractCall', {
      agentId: HELPER, chain: 'base', contract: pay.to, data: '0x', value: '0.001',
    })).body.outcome).toBe('sent');
    const rows = (await scope1.notices()).filter(row => row.card.txUrl);
    expect(rows).toHaveLength(4);
    expect(rows.map(row => row.card.operation)).toEqual(['send', 'send', 'swap', 'contract']);
    for (const row of rows) {
      expect(row.author_id).toBe(SYSTEM_IDENTITY_ID);
      expect(row.direct_participants.sort()).toEqual([SYSTEM_IDENTITY_ID, HUMAN].sort());
      expect(row.presentation).toBe('system');
      expect(row.card_type).toBeNull(); // DM push eligibility + the linked system-line renderer
      expect(row.card.txUrl).toMatch(/^https:\/\/basescan\.(?:io|org)\/tx\//);
      expect(row.text).toContain(row.card.counterparty);
      expect(row.text).toContain('base');
    }
    expect(rows[0]!.text).toContain('you');
    expect(rows.slice(1).every(row => row.text.includes('@bee') && row.card.agentId === HELPER)).toBe(true);
    expect(rows[2]!.text).toContain('USDC');
    expect(rows[2]!.text).toContain('ETH');
    expect(rows[2]!.text).toContain('confirmed swap');
    const history = await phoneFetch(`${scope1.origin}/v1/phone/rooms/${rows[0]!.room_id}/history`, {
      headers: { authorization: `Bearer ${scope1.accessToken}` },
    });
    expect(history.status).toBe(200);
    expect(JSON.stringify(await history.json())).toContain(rows[0]!.card.txUrl);
    expect((await scope1.database.query(`SELECT id FROM messages WHERE author_id=$1 AND card_type='wallet-tx'`,
      [SYSTEM_IDENTITY_ID])).rows).toHaveLength(0);
  });


  it('records indexed incoming receipts in wallet history without a System message', async () => {
    await scope1.createdWallet();
    await scope1.database.query(`INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('silent-wallet-device-token-123456789012345',$1,'android','physical')`, [HUMAN]);
    const send = vi.fn(async () => undefined);
    const push = new PushDeliveryLoop(scope1.database, { send });
    await push.runOnce();
    const txUrl = `https://basescan.org/tx/0x${'9'.repeat(64)}`;
    vi.spyOn(walletSource(), 'history').mockResolvedValue([{ direction: 'in', amountText: '+5 USDC', counterparty: 'sender', chain: 'base', balanceAfterUsd: '$5.00', agentName: null, txUrl, createdAt: 123 }]);
    await scope1.phoneOperation('readWallet', { workspaceId: WORKSPACE });
    const history = await scope1.daemonOperation('getWalletToolHistory', { agentId: HELPER });
    expect(history.body.entries).toEqual(expect.arrayContaining([expect.objectContaining({ direction: 'in', txUrl })]));
    expect((await scope1.database.query(`SELECT 1 FROM wallet_transactions WHERE identity_id=$1 AND tx_url=$2`, [HUMAN, txUrl])).rowCount).toBe(1);
    expect((await scope1.notices()).filter(row => row.card.txUrl === txUrl)).toEqual([]);
    expect(await push.runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    console.log('DM-1: wallet history read retains indexed incoming receipt; zero System messages for the receipt');
  });


  it('pending swaps get one notice without claiming confirmation or crediting output', async () => {
    await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const hash = `0x${'1'.repeat(64)}`;
    vi.spyOn(walletSource(), 'swap').mockResolvedValue({ txId: hash, toAmount: '100', status: 'pending' });
    const result = await scope1.daemonOperation('walletSwap', {
      agentId: HELPER, chain: 'base', fromAsset: 'usdc', toAsset: 'eth', amount: '3',
    });
    expect(result.body.outcome).toBe('pending');
    const rows = (await scope1.notices()).filter(row => row.card.txUrl?.endsWith(hash));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.card).toMatchObject({ status: 'pending', operation: 'swap', agentId: HELPER });
    expect(rows[0]!.text).toContain('confirmation pending');
    expect(rows[0]!.text).not.toContain('100 ETH');
    expect((await scope1.database.query(`SELECT id FROM wallet_transactions WHERE tx_id=$1`, [hash])).rows).toHaveLength(0);
  });


  it('completionV1 phone and agent sends preserve UNKNOWN without a success ledger or automatic resend', async () => {
    const wallet = await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    scope1.fundChain(wallet.address, 'base', 'usdc', 500);
    const source = vi.spyOn(walletSource(), 'sendTransaction').mockImplementation(async (_address, input) => {
      expect(input.completionV1).toBe(true);
      throw new WalletTransactionPending();
    });
    const input = { completionV1: true, chain: 'base', asset: 'usdc', amount: '2', to: `0x${'7'.repeat(40)}` };
    expect(await scope1.phoneOperation('sendFromWallet', { ...input, workspaceId: WORKSPACE })).toEqual({
      outcome: 'pending', reason: expect.stringContaining('UNKNOWN'),
    });
    expect((await scope1.daemonOperation('walletPay', { ...input, agentId: HELPER })).body).toEqual({
      outcome: 'pending', reason: expect.stringContaining('UNKNOWN'),
    });
    expect(source).toHaveBeenCalledTimes(2); // Two explicit independent actions; neither is redispatched.
    const pending = (await scope1.notices()).filter(row => row.card.status === 'pending');
    expect(pending).toHaveLength(2);
    expect(pending.every(row => !row.card.txUrl && row.card.reason?.includes('UNKNOWN'))).toBe(true);
    expect(pending.every(row => row.direct_participants.includes(HUMAN))).toBe(true);
    expect((await scope1.database.query(`SELECT id FROM wallet_transactions WHERE identity_id=$1 AND direction='out'`, [HUMAN])).rows).toHaveLength(0);
  });


  it.each([false, true].flatMap(providerFirst => [true, undefined].map(completionV1 =>
    ({ providerFirst, completionV1: completionV1 as true | undefined }))))
    ('an unconfirmed approval stays owner/chain/hash-bound without dependent submission (provider first=$providerFirst, completionV1=$completionV1)', async ({providerFirst, completionV1}) => {
    const wallet = await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    scope1.fundChain(wallet.address, 'base', 'usdc', 500);
    const hash = `0x${'c'.repeat(64)}`;
    const contract = `0x${'7'.repeat(40)}`;
    const client = new CdpWalletClient({ keyId: 'approval-fixture',
      keySecret: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      walletSecret: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
        .export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    const originalFetch = globalThis.fetch;
    let submissions = 0;
    let receipts = 0;
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
      if (String(url).startsWith(scope1.origin)) return originalFetch(url, options);
      if (String(url).endsWith('/send/transaction')) {
        submissions += 1;
        return Response.json({ transactionHash: hash });
      }
      const rows = JSON.parse(String(options?.body)) as { id: number; method: string }[];
      return Response.json(rows.map(({ id, method }) => {
        if (method === 'eth_getTransactionReceipt') { receipts += 1; return { id, result: null }; }
        expect(method).toBe('eth_getTransactionByHash');
        return { id, result: { from: wallet.address, to: contract, value: '0x0', input: '0x' } };
      }));
    });
    const source = vi.spyOn(walletSource(), 'contractCall').mockImplementation((address, input) => client.contractCall(address, input));
    const data = { address: wallet.address, transaction_hash: hash, network: 'base-mainnet' };
    if (providerFirst)
      expect((await scope1.deliverWalletEvent('wallet.transaction.confirmed', data, 'provider-first-approval')).status).toBe(200);
    const response = await scope1.daemonOperation('walletContractCall', {
      ...(completionV1 ? { completionV1 } : {}), agentId: HELPER, chain: 'base', contract, data: '0x12345678',
      approve: { asset: 'usdc', amount: '2' },
    });
    expect(response.body).toMatchObject({ outcome: 'pending', txUrl: walletExplorerTxUrl('base', hash),
      reason: expect.stringContaining('dependent transaction was not submitted') });
    expect(source.mock.calls[0]?.[1].completionV1).toBe(completionV1);
    expect({ submissions, receipts }).toEqual({ submissions: 1, receipts: 1 });
    const readApproval = async () => (await scope1.notices()).find(row => row.card.txUrl === walletExplorerTxUrl('base', hash))!;
    expect((await readApproval()).card).toMatchObject({ operation: 'approval',
      status: providerFirst ? 'confirmed' : 'pending', amountText: '2 USDC', agentId: HELPER });
    expect((await scope1.deliverWalletEvent('wallet.transaction.confirmed', { ...data, address: `0x${'9'.repeat(40)}` }, 'wrong-owner')).status).toBe(200);
    expect((await scope1.deliverWalletEvent('wallet.transaction.confirmed', { ...data, network: 'arbitrum-mainnet' }, 'wrong-chain')).status).toBe(200);
    expect((await scope1.deliverWalletEvent('wallet.transaction.confirmed', { ...data, transaction_hash: `0x${'d'.repeat(64)}` }, 'wrong-hash')).status).toBe(200);
    expect((await readApproval()).card.status).toBe(providerFirst ? 'confirmed' : 'pending');
    expect((await scope1.deliverWalletEvent('wallet.transaction.confirmed', data, 'approval-confirmed')).status).toBe(200);
    expect((await scope1.deliverWalletEvent('wallet.transaction.confirmed', data, 'approval-confirmed-repeat')).status).toBe(200);
    const settled = await readApproval();
    expect(settled.card).toMatchObject({ operation: 'approval', status: 'confirmed', agentId: HELPER });
    expect(settled.text).toContain('dependent transaction was not submitted');
    expect(settled.text).toContain('new explicit action');
    expect({ submissions, receipts }).toEqual({ submissions: 1, receipts: 1 });
    expect((await scope1.database.query(`SELECT id FROM wallet_transactions WHERE identity_id=$1 AND direction='out'`, [HUMAN])).rows).toHaveLength(0);
  });


  it('failed phone sends, agent sends and swaps, delegation and venue refusals all reach @System', async () => {
    const wallet = await scope1.createdWallet();
    scope1.fundChain(wallet.address, 'base', 'usdc', 500);
    const pay = { chain: 'base', asset: 'usdc', amount: '2', to: `0x${'7'.repeat(40)}` };
    expect((await scope1.daemonOperation('walletPay', { ...pay, agentId: HELPER })).body.outcome).toBe('delegation-expired');
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    vi.spyOn(walletSource(), 'sendTransaction').mockRejectedValue(new Error('CDP refused transfer'));
    expect(await scope1.phoneOperation('sendFromWallet', { ...pay, workspaceId: WORKSPACE })).toMatchObject({ outcome: 'failed' });
    expect((await scope1.daemonOperation('walletPay', { ...pay, agentId: HELPER })).body.outcome).toBe('failed');
    const hash = `0x${'2'.repeat(64)}`;
    vi.spyOn(walletSource(), 'swap').mockRejectedValue(new Error(`transaction ${hash} reverted`));
    expect((await scope1.daemonOperation('walletSwap', {
      agentId: HELPER, chain: 'base', fromAsset: 'usdc', toAsset: 'eth', amount: '3',
    })).body.outcome).toBe('failed');
    expect((await scope1.daemonOperation('walletPay', { ...pay, chain: 'arbitrum', to: BRIDGE2, agentId: HELPER })).body.outcome).toBe('failed');
    const rows = (await scope1.notices()).filter(row => row.card.status === 'failed');
    expect(rows).toHaveLength(5);
    expect(rows.every(row => row.author_id === SYSTEM_IDENTITY_ID && row.card.reason)).toBe(true);
    expect(rows.find(row => row.card.operation === 'swap')!.card.txUrl).toContain(hash);
    expect(rows.find(row => row.card.counterparty === BRIDGE2)!.text).toContain(BRIDGE2);
  });


  it('provider status and retries settle the same notice and preserve the initiating agent', async () => {
    const wallet = await scope1.createdWallet();
    const hash = `0x${'3'.repeat(64)}`;
    const notice: WalletNotice = { walletNotice: true, status: 'pending', operation: 'swap', execution: true,
      amountText: '3 USDC→ETH', counterparty: 'Coinbase CDP', chain: 'base', agentId: HELPER,
      agentName: '@bee', txUrl: walletExplorerTxUrl('base', hash) };
    await postWalletNotice(scope1.database, WORKSPACE, HUMAN, notice);
    const data = { address: wallet.address, transaction_hash: hash, network: 'base-mainnet' };
    expect((await scope1.deliverWalletEvent('wallet.transaction.failed', data)).status).toBe(200);
    expect((await scope1.deliverWalletEvent('wallet.transaction.failed', data, 'retry')).status).toBe(200);
    expect((await scope1.deliverWalletEvent('wallet.transaction.broadcast', data, 'late')).status).toBe(200);
    const rows = await scope1.notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.card).toMatchObject({ status: 'failed', agentId: HELPER, amountText: '3 USDC→ETH' });
    expect(rows[0]!.text).toContain('@bee');
  });


  it('signed Base transfer pushes arrive without a wallet read, merge logs and stay private per owner', async () => {
    const wallet = await scope1.createdWallet();
    const hash = `0x${'4'.repeat(64)}`;
    const data = { network: 'base-mainnet', transactionHash: hash, logIndex: 1,
      contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      from: `0x${'7'.repeat(40)}`, to: wallet.address, value: '5000000' };
    expect((await scope1.deliverWalletEvent('wallet.activity.multi', data)).status).toBe(200);
    expect((await scope1.deliverWalletEvent('wallet.activity.multi', data, 'retry')).status).toBe(200);
    expect((await scope1.deliverWalletEvent('wallet.activity.multi', { ...data, logIndex: 2,
      from: wallet.address, to: `0x${'8'.repeat(40)}`, value: '2000000' }, 'outgoing')).status).toBe(200);
    const rows = await scope1.notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.card.status).toBe('confirmed');
    expect(rows[0]!.text).toContain('+5 USDC');
    expect(rows[0]!.text).toContain('−2 USDC');
    expect(rows[0]!.text).toContain('initiator not known');
    expect(rows[0]!.direct_participants.sort()).toEqual([SYSTEM_IDENTITY_ID, HUMAN].sort());
    expect(rows[0]!.card.txUrl).toContain(hash);
  });
});
