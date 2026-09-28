import React, { useState } from 'react';
// @ts-expect-error The proof harness uses installed react-dom without shipping its types.
import { createRoot } from 'react-dom/client';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { PageHeader } from '../sources/components/buzz/PageHeader';
import { ServiceMark } from '../sources/components/buzz/ServiceMark';
import { ToolDetailsCell } from '../sources/components/buzz/ToolDetailsCell';
import { Typography } from '../sources/constants/Typography';

// Render the shipped Workbench row components and theme against a mock read
// projection. The production OAuth and Link approval flow are not exercised.
function Proof() {
  const initial = new URLSearchParams(location.search).get('state');
  const [connected, setConnected] = useState(initial === 'connected');
  const ineligible = initial === 'ineligible';
  return (
    <View style={styles.container}>
      <PageHeader eyebrow="Settings" title="Workbench" />
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        <View>
          <Text style={styles.sectionLabel}>Payment tools</Text>
          <ToolDetailsCell
            testID="workbench-link"
            title="Link"
            leading={<ServiceMark company="Link" domain="link.com" testID="workbench-link-mark" />}
            detailText={ineligible
              ? 'Link agent payments are available only to consumers in the US or Canada.'
              : 'Approve each purchase in Link before your agents use a one-time payment card.'}
            descriptionText={ineligible
              ? 'Your Link account is not eligible. Available only in the US or Canada.'
              : !connected ? 'Available to consumers in the US or Canada.' : undefined}
            action={!connected ? 'Connect' : undefined}
            actionTestID="workbench-link-connect"
            onAction={() => setConnected(true)}
            value={connected ? 'connected' : undefined}
          />
        </View>
      </ScrollView>
      <Text style={styles.proofNote}>LOCAL UI PROOF · MOCK LINK STATUS · NO OAUTH OR PURCHASE</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    content: { flex: 1 },
    contentInner: { padding: hull.space.md, gap: hull.layout.sectionGap,
      paddingTop: hull.layout.screenTop, paddingBottom: hull.space.xxl },
    sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.textMuted },
    proofNote: { ...hull.type.meta, color: hull.ledgerQuiet, padding: hull.space.md },
  };
});

createRoot(document.getElementById('root')!).render(<Proof />);
