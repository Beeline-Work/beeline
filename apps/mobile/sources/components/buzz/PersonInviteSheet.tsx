import React, { useState } from 'react';
import { Linking, Platform, Share, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet } from 'react-native-unistyles';
import { ErrorBanner } from './ErrorBanner';
import { Modal } from '@/modal';
import { sharePersonInvite } from '@/buzz/share-person-invite';
import { HullActionSheet, HullActionSheetCancel } from './HullActionSheet';
import { HullDialogInput } from './HullDialog';
import { Button } from './Button';

export function PersonInviteSheet({ url, onClose }: { url: string; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <HullActionSheet title="Invite a person" footer={<HullActionSheetCancel onPress={onClose} />}>
      <View style={styles.content}>
      {error ? <ErrorBanner inline title={error} /> : null}
      <HullDialogInput accessibilityLabel="Invite link" value={url} editable={false} />
      <Button size="inline" label={copied ? 'Copied' : 'Copy'} onPress={async () => {
        try {
          await Clipboard.setStringAsync(url);
          setCopied(true);
          setError(null);
        } catch { setError('Could not copy. Select and copy the invite link.'); }
      }} />
      <HullDialogInput accessibilityLabel="Email address" placeholder="Email address" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
      <Button size="inline" label="Email invite" disabled={!email.trim()} onPress={() => {
        void Linking.openURL(`mailto:${encodeURIComponent(email.trim())}?subject=Beeline%20invite&body=${encodeURIComponent(url)}`).catch(() => setError('Could not open email. Copy the invite link instead.'));
      }} />
      </View>
    </HullActionSheet>
  );
}

export function presentPersonInvite(url: string): Promise<void> {
  const share = Platform.OS !== 'web' || typeof navigator !== 'undefined' && typeof navigator.share === 'function'
    ? (content: { message: string }) => Share.share(content)
    : undefined;
  return sharePersonInvite(url, share, (link) => {
    Modal.show({ component: PersonInviteSheet, props: { url: link } });
  });
}

const styles = StyleSheet.create(({ buzz }) => ({ content: { paddingHorizontal: buzz.space.lg, gap: buzz.space.sm } }));
