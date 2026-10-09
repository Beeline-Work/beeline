import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { TranscriptCard } from '../sources/components/buzz/TranscriptCard';
import { IdentityMark } from '../sources/components/buzz/IdentityMark';
import {
  connectorOfferActionLabel,
  connectorOfferTitle,
  connectorOfferWaitingLine,
} from '../sources/buzz/connector-offer-copy';
import { connectorOfferConsequence } from '@beeline/api-contract/connector-offers';

/**
 * The "switch Trusty Squire account" card, phone width, in the theme the
 * shimmed Unistyles hands it. Built from the same primitives
 * `ConnectorOfferCard` composes (TranscriptCard + IdentityMark); the proposed
 * copy sits beside today's real `add` card so the two read as one family.
 */
const zeke = { pubkey: 'zeke', name: 'Zeke', handle: '@zeke' };
const SWITCH_TITLE = "Switch Trusty Squire's Google account?";
const SWITCH_LINE =
  "You'll sign in to Google again, with the account Trusty Squire should use. The account signed in now is replaced for every task on this machine. Then I can sign up for Vercel with your work account";
const SWITCH_ACTION = '✓ Switch account';

function Mark() {
  return <IdentityMark kind="agent" seed="monarch" name="Monarch" size={26} />;
}

function Label({ children }: { children: string }) {
  const { theme } = useUnistyles();
  return (
    <Text style={{ ...theme.buzz.type.sectionHead, color: theme.buzz.textSecondary, marginTop: 8 }}>
      {children}
    </Text>
  );
}

function Harness() {
  const { theme } = useUnistyles();
  return (
    <View style={{ backgroundColor: theme.buzz.bgBase, paddingVertical: 16, paddingHorizontal: 8, gap: 10, minHeight: '100%' }}>
      <Label>NEW · SWITCH ACCOUNT · YOU CAN ACT</Label>
      <TranscriptCard
        tier="ask"
        wrapTitle
        identity={<Mark />}
        title={SWITCH_TITLE}
        subline={SWITCH_LINE}
        stamp="12:04"
        actions={[{ label: SWITCH_ACTION, primary: true, onPress: () => undefined }]}
      />
      <Label>NEW · SWITCH ACCOUNT · SOMEONE ELSE READS IT</Label>
      <TranscriptCard
        tier="ask"
        wrapTitle
        identity={<Mark />}
        title={SWITCH_TITLE}
        subline={SWITCH_LINE}
        stamp="12:04"
        footerNote={connectorOfferWaitingLine({ addressee: zeke })}
      />
      <Label>NEW · AFTER THE TAP · SIGN-IN OPEN</Label>
      <TranscriptCard
        tier="ask"
        wrapTitle
        identity={<Mark />}
        title={SWITCH_TITLE}
        subline={SWITCH_LINE}
        stamp="12:04"
        footerNote="switching for @zeke"
        actions={[{ label: 'Continue sign-in ›', primary: true, onPress: () => undefined }]}
      />
      <Label>NEW · SETTLED</Label>
      <TranscriptCard
        tier="record"
        wrapTitle
        identity={<Mark />}
        title={SWITCH_TITLE}
        subline={SWITCH_LINE}
        stamp="12:04"
        footerNote="switched by @zeke · 12:06"
        actions={[{ label: 'Manage ›', accessibilityRole: 'link', onPress: () => undefined }]}
      />
      <Label>TODAY · ADD CARD (UNCHANGED)</Label>
      <TranscriptCard
        tier="ask"
        wrapTitle
        identity={<Mark />}
        title={connectorOfferTitle('Trusty Squire')}
        subline={connectorOfferConsequence('trusty-squire', 'provision the Vercel API key into its vault')}
        stamp="12:01"
        actions={[{ label: connectorOfferActionLabel('Trusty Squire'), primary: true, onPress: () => undefined }]}
      />
    </View>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
setTimeout(() => {
  document.getElementById('result')!.textContent = 'PASS';
}, 800);
