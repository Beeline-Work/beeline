import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams } from 'expo-router';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { savePendingBrowserShare, validBrowserShareId } from '@/buzz/pending-browser-share';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { ComputerSessionViewer, type ComputerSessionView } from '@/components/buzz/ComputerSession';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/** Public share links enter through phone authentication before opening the viewer. */
export default function BrowserShare() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [session, setSession] = React.useState<ComputerSessionView | null>(null);
  const [message, setMessage] = React.useState('Opening shared browser…');
  React.useEffect(() => {
    let active = true;
    setSession(null);
    void (async () => {
      if (!validBrowserShareId(id)) {
        if (active) setMessage('This shared browser link is invalid.');
        return;
      }
      if (!(await loadBuzzIdentity())) {
        await savePendingBrowserShare(id);
        if (active) router.replace('/beeline/onboarding');
        return;
      }
      const { access } = await monolithPhoneOperation('openComputerSession', { id });
      if (active) setSession({ id, access, url: `${getBuzzRuntimeConfig().monolithUrl}/s/${id}/`, title: 'Shared browser', status: 'live' });
    })().catch(() => {
      if (active) setMessage('You do not have access to this shared browser, or the session has ended. Open the card in its Room to check.');
    });
    return () => { active = false; };
  }, [id]);
  return session ? <ComputerSessionViewer session={session} onClose={() => router.replace('/beeline/channels')} /> : <View style={styles.status}><Text style={styles.message} accessibilityRole="alert">{message}</Text></View>;
}

const styles = StyleSheet.create((theme) => ({
  status: { flex: 1, justifyContent: 'center', padding: theme.buzz.space.md, backgroundColor: theme.buzz.bgBase },
  message: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
}));
