import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  connectorOfferConsequence,
  squireAccountSwitchConsequence,
  type ConnectorOfferCardView,
} from '@beeline/api-contract/connector-offers';
import { ConnectorOfferCard } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';

/**
 * The "switch Trusty Squire account" card at phone width, painted by the real
 * `ConnectorOfferCard` in the theme the shimmed Unistyles hands it: ready for
 * the addressee, waiting for anyone else, signing in, settled — with today's
 * `add` card beside it. `connector-switch-proof.browser.test.ts` captures it.
 */
const monarch = { pubkey: 'monarch', kind: 'agent', name: 'Monarch', handle: '@monarch' } as const;
const zeke = { pubkey: 'zeke', kind: 'human', name: 'Zeke', handle: '@zeke' } as const;
const at = (hour: number, minute: number) => new Date(2026, 9, 9, hour, minute).getTime() / 1000;

const switchOffer: ConnectorOfferCardView = {
  offerId: 'switch',
  agent: monarch,
  addressee: zeke,
  connectorType: 'trusty-squire',
  connectorName: 'Trusty Squire',
  reason: 'sign up for Vercel with your work account',
  consequence: squireAccountSwitchConsequence('sign up for Vercel with your work account'),
  helper: { machineId: 'machine', name: 'studio' },
  status: 'pending',
  createdAt: at(12, 4),
  intent: 'switch',
  provider: 'google',
};
const addOffer: ConnectorOfferCardView = {
  ...switchOffer,
  offerId: 'add',
  reason: 'provision the Vercel API key into its vault',
  consequence: connectorOfferConsequence('trusty-squire', 'provision the Vercel API key into its vault'),
  createdAt: at(12, 1),
  intent: undefined,
  provider: undefined,
};

function Label({ children }: { children: string }) {
  const { theme } = useUnistyles();
  return (
    <Text style={{ ...theme.buzz.type.sectionHead, color: theme.buzz.textSecondary, marginTop: 8, marginHorizontal: 8 }}>
      {children}
    </Text>
  );
}

function Card({ offer, viewer }: { offer: ConnectorOfferCardView; viewer: string }) {
  return (
    <ConnectorOfferCard
      message={{ id: offer.offerId, text: '', isUser: false, timestamp: offer.createdAt, connectorOffer: offer } as never}
      viewerIsAgent={false}
      viewerPubkey={viewer}
      viewerRole="member"
      actionId={null}
      onAccept={() => undefined}
      onContinue={() => undefined}
      onOpenWorkbench={() => undefined}
    />
  );
}

function Harness() {
  const { theme } = useUnistyles();
  const accepted = { acceptedBy: zeke, acceptedAt: at(12, 6), connectorId: 'connector' };
  return (
    <View style={{ backgroundColor: theme.buzz.bgBase, paddingVertical: 16, paddingHorizontal: 8, gap: 10, minHeight: '100%' }}>
      <Label>SWITCH ACCOUNT · YOU CAN ACT</Label>
      <Card offer={switchOffer} viewer="zeke" />
      <Label>SWITCH ACCOUNT · SOMEONE ELSE READS IT</Label>
      <Card offer={switchOffer} viewer="reader" />
      <Label>AFTER THE TAP · SIGN-IN OPEN</Label>
      <Card offer={{ ...switchOffer, ...accepted, status: 'connecting' }} viewer="zeke" />
      <Label>SETTLED</Label>
      <Card offer={{ ...switchOffer, ...accepted, status: 'accepted' }} viewer="zeke" />
      <Label>ADD CARD (UNCHANGED)</Label>
      <Card offer={addOffer} viewer="zeke" />
    </View>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
setTimeout(() => {
  const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
  document.getElementById('result')!.textContent = [
    'PASS',
    `action ${text('connector-offer-switch-accept')}`,
    `waiting ${text('connector-offer-switch-waiting')}`,
    `connecting ${text('connector-offer-switch-connecting')}`,
    `outcome ${text('connector-offer-switch-outcome')}`,
    `add ${text('connector-offer-add-accept')}`,
  ].join(' | ');
}, 800);
