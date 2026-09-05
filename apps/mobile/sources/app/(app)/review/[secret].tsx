import React, { useEffect } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams } from 'expo-router';
import { useURL } from 'expo-linking';
import { PixelLoader } from '@/components/buzz/MonoHull';
import { signInWithReviewSecret } from '@/auth/review-sign-in';
import { parseReviewSecret } from '@/buzz/review-link';

/**
 * The Google Play review link's landing route (`https://usebeeline.app/review/<secret>`).
 *
 * Nothing links here. Android's verified app link is the only way in, so the
 * app gains no control and no ordinary user ever sees this screen. It signs the
 * device in as the review identity and hands it to the Room deck; anything the
 * server refuses lands on the ordinary sign-in screen with no hint that a
 * review link exists.
 */
export default function ReviewSignIn() {
  const { secret: routeSecret } = useLocalSearchParams<{ secret?: string | string[] }>();
  const incomingUrl = useURL();
  const secret = parseReviewSecret(routeSecret) ?? parseReviewSecret(incomingUrl ?? undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!secret) {
        router.replace('/beeline/onboarding');
        return;
      }
      try {
        await signInWithReviewSecret(secret);
        if (!cancelled) router.replace('/beeline/channels');
      } catch {
        if (!cancelled) router.replace('/beeline/onboarding');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [secret]);

  return (
    <View style={styles.container}>
      <PixelLoader compact />
      <Text style={styles.status}>signing in…</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.buzz.bgTerminal,
  },
  status: { ...theme.buzz.type.meta, marginTop: theme.buzz.space.md, color: theme.buzz.muted },
}));
