import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ButtonRow } from '../sources/components/buzz/ButtonRow';
import { ErrorBanner } from '../sources/components/buzz/ErrorBanner';
const calls: string[] = [];
const before = location.search.includes('before');
const styles = StyleSheet.create(({ buzz }) => ({
  card: { marginTop: 4, marginHorizontal: 8, padding: 8, borderWidth: 1, borderColor: buzz.borderStrong, backgroundColor: buzz.bgHighlight },
  title: { ...buzz.type.sectionHead, fontFamily: buzz.monoSemibold, color: buzz.textPrimary },
}));
createRoot(document.getElementById('root')!).render(<View style={{ padding: 16 }}>
  {before ? <View style={styles.card} testID="main-delivery"><Text style={styles.title}>DELIVERY FAILED</Text><ButtonRow actions={[
    { label: 'Dismiss', onPress: () => calls.push('dismiss') },
    { label: 'Retry', variant: 'primary', onPress: () => calls.push('retry') },
  ]} /></View> : <ErrorBanner title="Delivery failed" retryLabel="Retry" onRetry={() => calls.push('retry')}
    secondaryAction={{ label: 'Dismiss', onPress: () => calls.push('dismiss') }} testID="delivery" />}
</View>);
setTimeout(() => {
  try {
    if (before) { document.getElementById('result')!.textContent = 'PASS main delivery fixture ' + JSON.stringify(document.querySelector('[data-testid=main-delivery]')!.getBoundingClientRect().toJSON()); return; }
    const get = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    get('delivery-retry').click(); get('delivery-secondary').click();
    if (calls.join(',') !== 'retry,dismiss') throw Error('Actions were not independent');
    for (const id of ['delivery-retry', 'delivery-secondary']) {
      if (get(id).getBoundingClientRect().height < 44) throw Error('Touch target below 44px');
    }
    document.getElementById('result')!.textContent = 'PASS delivery Retry and Dismiss; 44px targets ' + JSON.stringify({ banner: get('delivery').getBoundingClientRect().toJSON(), retry: get('delivery-retry').getBoundingClientRect().toJSON(), dismiss: get('delivery-secondary').getBoundingClientRect().toJSON() });
  } catch (error) { document.getElementById('result')!.textContent = String(error); }
}, 250);
