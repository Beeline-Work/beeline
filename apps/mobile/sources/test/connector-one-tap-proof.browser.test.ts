import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';

/**
 * Captures each Connectors tap case at phone width: the real Connectors list,
 * one tap on a row, then the real screen that tap opened. It writes files, so
 * it runs only when asked:
 *
 *   ONE_TAP_PROOF_OUT=../../.verification/connector-one-tap \
 *     npx vitest run sources/test/connector-one-tap-proof.browser
 */
const out = process.env.ONE_TAP_PROOF_OUT;

function fontsCss(mobile: string) {
  return ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular', 'IBMPlexMono-SemiBold']
    .map((font) => path.join(mobile, 'sources/assets/fonts', `${font}.ttf`))
    .filter(existsSync)
    .map((file) => `@font-face{font-family:'${path.basename(file, '.ttf')}';src:url(data:font/ttf;base64,${readFileSync(file).toString('base64')})}`)
    .join('');
}

const CASES = ['suggest', 'list', 'coinbase', 'openrouter', 'github', 'github-actions', 'linear', 'notion', 'stripe', 'squire-signin'] as const;

it.skipIf(!out || !existsSync(CHROME))('captures every Connectors tap case', async () => {
  const mobile = process.cwd();
  await mkdir(out!, { recursive: true });
  const directory = await mkdtemp(path.join(mobile, 'sources/test/one-tap-proof-'));
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(entry, `import React from 'react'; import { createRoot } from 'react-dom/client';
      const which = new URLSearchParams(location.search).get('case');
      Promise.all([import('@/app/(app)/beeline/settings/workbench'), import('@/app/(app)/beeline/settings/workbench/wallet'),
        import('@/app/(app)/beeline/settings/workbench/service'), import('@/app/(app)/beeline/settings/workbench/app')])
        .then(([a, b, c, d]) => run({ workbench: a.default, wallet: b.default, service: c.default, app: d.default }))
        .catch(error => { document.getElementById('result').textContent = 'load error: ' + (error?.stack ?? error); });
      function run(screens) {
        globalThis.__params = { workspaceId: 'ws', viewerId: 'viewer' };
        globalThis.__pushes = []; globalThis.__backs = 0; globalThis.__signIn = []; globalThis.__empty = which === 'suggest';
        const company = which === 'github-actions' ? 'github' : which;
        const root = createRoot(document.getElementById('root'));
        root.render(<screens.workbench />);
        setTimeout(() => {
          if (which === 'suggest') document.querySelector('[data-testid="connectors-suggest-tailscale"]').click();
          else if (which !== 'list') document.querySelector('[data-testid="connectors-company-' + company + '"]').click();
          setTimeout(() => {
            const push = globalThis.__pushes[0];
            if (push && screens[push.pathname.split('/').pop()]) {
              globalThis.__params = push.params;
              const Screen = screens[push.pathname.split('/').pop()];
              root.render(<Screen />);
            }
            setTimeout(() => {
              // A connected app acts on its info page: its row opens the actions in place, and Back leaves for Connectors.
              if (which === 'github-actions') {
                document.querySelector('[data-testid="company-item-github-app"]').click();
                document.querySelector('[aria-label="Back to Connectors"]').click();
              }
              setTimeout(() => {
                document.getElementById('result').textContent = JSON.stringify({ pushes: globalThis.__pushes, backs: globalThis.__backs, signIn: globalThis.__signIn,
                  text: document.body.innerText.slice(0, 700) });
              }, 400);
            }, 1200);
          }, 300);
        }, 1200);
      }`);
    const base = webProofShims(mobile);
    const results: Record<string, unknown> = {};
    // Chrome prints the DOM or takes the screenshot, not both: one run each.
    for (const name of CASES) for (const screenshot of name === 'linear' ? [false] : [false, true]) {
      const { result, status, stderr } = await runBrowserProof({
        entry, mobile, width: 390, height: 844, query: `?case=${name}`, budgetMs: 8000,
        head: `<style>${fontsCss(mobile)}</style>`,
        ...(screenshot ? { screenshotPath: path.resolve(out!, `${name}.png`) } : {}),
        shims: {
          ...base,
          '@expo/vector-icons': 'export const Ionicons = () => null;',
          'expo-web-browser': 'export const openAuthSessionAsync = async () => ({ type: "cancel" }); export const openBrowserAsync = async url => { globalThis.__signIn.push(url); };',
          'expo-router': `import { useEffect } from 'react';
            export const useLocalSearchParams = () => globalThis.__params;
            export const useFocusEffect = effect => useEffect(() => effect(), [effect]);
            export const router = { back() { globalThis.__backs += 1; }, replace() {}, push(href) { globalThis.__pushes.push(href); } };`,
          '@/buzz/runtime-config': 'export const getBuzzRuntimeConfig = () => ({ monolithUrl: "https://monolith.test" });',
          '@/auth/auth-session': 'export const authSessionOptions = () => ({});',
          '@/buzz/wallet-workspace': 'export const resolveWalletWorkspaceId = async id => id || "ws";',
          '@/auth/buzz-identity-storage': `export const loadBuzzIdentity = async () => ({ publicKey: 'viewer' });
            export const getEffectiveRelayUrl = async () => 'https://monolith.test';`,
          '@/sync/transport/live-connection': 'export const sharedLiveConnection = () => ({ register: async () => () => undefined });',
          '@/sync/transport/monolith-operation': `
            const logo = id => ({ kind: 'website' });
            const row = (id, name, domain, section, items, extra = {}) => ({ id, name, domain, kind: 'company', section, logo: logo(id),
              subtitle: '', items, machines: [], alsoAvailable: [], ...extra });
            const key = (id, title, subtitle, extra = {}) => ({ id, title, subtitle, kind: 'key', target: { kind: 'key', connectionId: id }, ...extra });
            const rows = [
              row('linear', 'Linear', 'linear.app', 'attention', [{ id: 'linear', title: 'Linear', subtitle: 'via Composio', kind: 'connection', target: { kind: 'app', appId: 'linear' }, status: 'Offline', attention: true }],
                { subtitle: '1 app', status: 'Offline', attention: '1 connection needs attention' }),
              row('notion', 'Notion', 'notion.so', 'attention', [{ id: 'notion', title: 'Notion', subtitle: 'via Trusty Squire', kind: 'connection', target: { kind: 'app', appId: 'notion' }, status: 'Offline', attention: true }],
                { subtitle: '1 app', status: 'Offline', attention: '1 connection needs attention' }),
              row('stripe', 'Stripe', 'stripe.com', 'attention', [key('stripe-key', 'Stripe key', 'stripe.com', { status: 'Expired', attention: true })],
                { subtitle: '1 key', status: 'Expired', attention: '1 connection needs attention' }),
              { ...row('squire-signin', 'Trusty Squire', 'trustysquire.ai', 'attention', []), kind: 'sign-in-service', subtitle: '2 computers', status: 'Sign-in unavailable',
                attention: '1 computer needs attention', machines: [
                  { id: 'laptop', name: 'Laptop', online: true, status: 'error', error: 'Google reconnect failed', statusText: 'Google sign-in expired' },
                  { id: 'desktop', name: 'Desktop', online: false, status: 'connected', statusText: 'Computer offline' }] },
              row('github', 'GitHub', 'github.com', 'apps', [{ id: 'github-app', title: 'GitHub', subtitle: 'via Composio', kind: 'connection', target: { kind: 'app', appId: 'github' }, status: 'Connected' }], { subtitle: '1 app' }),
              row('coinbase', 'Coinbase', 'coinbase.com', 'apps', [{ id: 'builtin:wallet', title: 'Wallet', subtitle: 'built in', kind: 'connection', target: { kind: 'wallet' } }], { subtitle: '1 app' }),
              row('openrouter', 'OpenRouter', 'openrouter.ai', 'keys', [key('or-default', 'OpenRouter key', 'openrouter.ai'), key('or-agents', 'Agents', 'openrouter.ai')], { subtitle: '2 keys' }),
            ];
            const apps = [{ id: 'github', key: 'github', name: 'GitHub', domain: 'github.com', transport: 'composio', status: 'connected', useCount: 0 },
              { id: 'linear', key: 'linear', name: 'Linear', domain: 'linear.app', transport: 'composio', status: 'error', useCount: 0 },
              { id: 'notion', key: 'notion', name: 'Notion', domain: 'notion.so', transport: 'squire-browser', status: 'error', helperId: 'laptop', helperName: 'Laptop', errorMessage: 'Notion sign-in expired', useCount: 0 }];
            const wallet = () => ({ address: '0x1234567890abcdef1234567890abcdef12347890', solanaAddress: null, totalUsd: '$100.00',
              coins: [{ symbol: 'USDC', name: 'USD Coin', amount: '100', usd: '$100.00', chain: 'base' }], chains: [], sponsorship: null,
              delegation: { active: true, expiresAt: null } });
            export class MonolithPhoneOperationError extends Error {}
            export const phoneOperationFailureReason = error => String(error?.message ?? error);
            export const monolithPhoneOperation = async (operation, input) => {
              if (operation === 'readWorkbench') return { workspaceId: 'ws', helpers: [], connectors: [], connections: [], apps: apps.map(a => ({ appId: a.id, appKey: a.key, name: a.name, domain: a.domain, transport: a.transport, route: a.transport, status: a.status, helperId: a.helperId, helperName: a.helperName, errorMessage: a.errorMessage, accountLabel: 'Owner', workspaceName: 'Work', useCount: 0, createdAt: 1 })),
                catalog: [], wallet: { createdAt: 1, delegationActive: true, delegationExpiresAt: null },
                companies: globalThis.__empty ? { version: 1, rows: [], hasConnections: false, summary: { value: '0 connections' }, suggestions: [
                    { appKey: 'tailscale', appName: 'Tailscale', name: 'Tailscale', purpose: 'Reach devices on your private network.', providerId: 'tailscale', providerName: 'Tailscale', domain: 'tailscale.com', logo: logo(), flow: 'tailscale' },
                    { appKey: 'linear', appName: 'Linear', name: 'Linear', purpose: 'Track issues and project work.', providerId: 'linear', providerName: 'Linear', domain: 'linear.app', logo: logo(), flow: 'app' }] }
                  : { version: 1, rows, suggestions: [], hasConnections: true, summary: { value: rows.length + ' connections' } } };
              if (operation === 'beginAppSignIn') return { authorizationUrl: 'https://linear.app/oauth/authorize?app=' + input.appId };
              if (operation === 'readWallet') return wallet();
              if (operation === 'readWalletHistory') return { entries: [
                { direction: 'in', amountText: '+140 USDC', counterparty: '0xfeed…beef', chain: 'base', createdAt: Date.now() / 1000 - 7200 },
                { direction: 'out', amountText: '−40 USDC', counterparty: 'shop.example', chain: 'base', agentName: '@bee', createdAt: Date.now() / 1000 - 600 }] };
              return {};
            };`,
        },
      });
      expect(status, stderr).toBe(0);
      // A provider sign-in leaves the app: on web the real openAppSignIn sends the tab to the server's OAuth start.
      const left = result.match(/"reloadUrl":"([^"]+)"/)?.[1];
      if (!screenshot) results[name] = left ? { navigatedTo: decodeURIComponent(left) } : JSON.parse(result);
    }
    await writeFile(path.resolve(out!, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 300000);
