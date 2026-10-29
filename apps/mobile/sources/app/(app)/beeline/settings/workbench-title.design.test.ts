import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workbench = readFileSync(new URL('./workbench.tsx', import.meta.url), 'utf8');
const connect = readFileSync(new URL('./workbench/connect.tsx', import.meta.url), 'utf8');
const wallet = readFileSync(new URL('./workbench/wallet.tsx', import.meta.url), 'utf8');
const connection = readFileSync(new URL('./workbench/connection.tsx', import.meta.url), 'utf8');
const walletSend = readFileSync(new URL('./workbench/wallet-send.tsx', import.meta.url), 'utf8');
const walletReceive = readFileSync(
  new URL('./workbench/wallet-receive.tsx', import.meta.url),
  'utf8',
);
const signIn = readFileSync(new URL('./workbench/connect-signin.tsx', import.meta.url), 'utf8');
const appLayout = readFileSync(new URL('../../_layout.tsx', import.meta.url), 'utf8');

describe('Workbench title hierarchy', () => {
  it('puts small Settings over large Workbench on the list', () => {
    expect(workbench).toContain('<PageHeader');
    expect(workbench).toContain('eyebrow="Settings"');
    expect(workbench).toContain('title="Connectors"');
    expect(workbench).not.toMatch(/desktop \? <PageHeader/);
  });

  it('puts small Workbench over the tool or key name on every child page', () => {
    // The locked Trusty Squire mock v3 names the parent tool over "Connect <computer>".
    expect(connect).toContain('eyebrow={connectorName}');
    expect(connect).toContain('`Connect ${machineName}`');
    expect(wallet).toContain('eyebrow="Connectors"');
    expect(wallet).toContain('title={title}');
    expect(connection).toContain('eyebrow="Connectors"');
    expect(connection).toContain('testID="connection-header"');
    expect(walletSend).toContain('eyebrow="Wallet"');
    expect(walletSend).toContain('title="Send"');
    expect(walletReceive).toContain('eyebrow="Wallet"');
    expect(walletReceive).toContain('title="Receive"');
    // Mock v3: the sign-in page is step 4 of the pairing it belongs to.
    expect(signIn).toContain("eyebrow={squire ? 'Step 4 of 4' : 'Connectors'}");
    expect(signIn).toContain("title={squire ? 'Sign in to Google' : `Sign in to ${connectorName}`}");
    expect(signIn).not.toContain('width: 40, height: 40');
  });

  it('hides the stack header so PageHeader is the only title', () => {
    for (const name of [
      'beeline/settings/workbench',
      'beeline/settings/workbench/connection',
      'beeline/settings/workbench/wallet',
      'beeline/settings/workbench/wallet-send',
      'beeline/settings/workbench/wallet-receive',
      'beeline/settings/workbench/connect',
      'beeline/settings/workbench/connect-signin',
    ]) {
      expect(appLayout).toMatch(new RegExp(`name="${name.replace(/\//g, '\\/')}"[\\s\\S]*?headerShown: false`));
    }
  });
});
