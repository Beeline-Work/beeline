import React from 'react';
import { Text, View } from 'react-native';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
// @ts-expect-error Supplied by the proof's shim: the server's wallet.svg file.
import walletSvg from 'proof:wallet-svg';
import { TranscriptCard } from '../sources/components/buzz/TranscriptCard';
import { IdentityMark } from '../sources/components/buzz/IdentityMark';
import { DirectMessageHeaderIdentity } from '../sources/components/buzz/DirectMessageHeaderIdentity';
import { HeaderMetaCaps } from '../sources/components/buzz/HeaderLadder';
import { directMessageAgentHeaderMeta } from '../sources/buzz/direct-message-header-presence';
import { beelineThemes } from '../sources/buzz/groknight';

/**
 * The @Wallet DM as a person sees it: its header mark, the standing permission
 * card, and an agent DM's header line. The connector logo is the file the
 * server serves at /v1/connectors/logo/wallet.svg.
 */
const LOGO_URL = 'https://server.test/v1/connectors/logo/wallet.svg';
const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  String(input) === LOGO_URL
    ? Promise.resolve(new Response(walletSvg, { headers: { 'content-type': 'image/svg+xml' } }))
    : realFetch(input, init)) as typeof window.fetch;

const theme = beelineThemes.obsidian;
const pause = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

function Harness() {
  const walletMark = (
    <IdentityMark kind="human" seed="wallet" name="Wallet" avatarUrl={LOGO_URL} size={26} />
  );
  return (
    <View style={{ backgroundColor: theme.bgBase, padding: 16, gap: 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }} testID="wallet-header">
        <DirectMessageHeaderIdentity
          isDirectMessage
          readOnly
          peerPubkey="wallet"
          connectorAvatarUrl={LOGO_URL}
          kind="human"
          avatarUrl={LOGO_URL}
          name="Wallet"
        />
        <Text style={{ ...theme.type.bodyStrong, color: theme.textPrimary }}>@Wallet</Text>
      </View>
      <TranscriptCard
        tier="record"
        identity={walletMark}
        title="Granted agents permission to sign"
        subline="Stands until revoked"
        sublineTestID="wallet-delegation-subline"
        stamp="17:04"
        testID="wallet-delegation"
      />
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <IdentityMark kind="agent" seed="ruby" name="Ruby" size={26} />
        <View style={{ marginLeft: 8 }}>
          <Text style={{ ...theme.type.bodyStrong, color: theme.textPrimary }}>Ruby</Text>
          <HeaderMetaCaps testID="agent-dm-meta">
            {directMessageAgentHeaderMeta(
              { handle: 'ruby', model: 'anthropic/claude-opus-5-5', ownerHandle: 'lunchboxfortwo' },
              '',
            )}
          </HeaderMetaCaps>
        </View>
      </View>
    </View>
  );
}

const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();

async function run() {
  createRoot(document.getElementById('root')!).render(<Harness />);
  await pause();
  await pause(600);
  const card = rect('[data-testid="wallet-delegation"]');
  const title = rect('[data-testid="wallet-delegation-title"]');
  const subline = rect('[data-testid="wallet-delegation-subline"]');
  // The card's border is 1px on each side; measure the inset inside it.
  const top = Math.round(title.top - card.top - 1);
  const bottom = Math.round(card.bottom - 1 - subline.bottom);
  const logos = [...document.querySelectorAll('[data-testid="identity-connector-logo"]')].map(
    (logo) => {
      const ground = logo.querySelector('rect')?.getAttribute('fill');
      const shape = [...logo.querySelectorAll('path')].map((path) =>
        path.getAttribute('d')?.slice(0, 8),
      );
      return `${ground}+${shape.join('+')}`;
    },
  );
  const meta = document.querySelector('[data-testid="agent-dm-meta"]')?.textContent ?? '';
  report(
    `PASS card top ${top}px bottom ${bottom}px | logos ${logos.join(',')} | agent meta ${meta}`,
  );
}

run().catch((error) => report(String(error)));
