import React, { useEffect } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams } from 'expo-router';
import { useURL } from 'expo-linking';
import { PixelLoader } from '@/components/buzz/MonoHull';
import { MonoButton } from '@/components/buzz/MonoHull';
import { signInWithReviewSecret } from '@/auth/review-sign-in';
import { parseReviewSecret } from '@/buzz/review-link';

/**
 * The store-reviewer landing route. Both `https://usebeeline.app/review/<secret>`
 * and the association-independent `beeline://review/<secret>` resolve here.
 *
 * Nothing inside the app links here, so the app gains no control and no
 * ordinary user ever sees this screen. It signs the
 * device in as the review identity and hands it to the Room deck; anything the
 * server refuses lands on the ordinary sign-in screen with no hint that a
 * review link exists.
 */
export default function ReviewSignIn() {
  const { secret: routeSecret } = useLocalSearchParams<{ secret?: string | string[] }>();
  const incomingUrl = useURL();
  const secret = parseReviewSecret(routeSecret) ?? parseReviewSecret(incomingUrl ?? undefined);
  const [failure, setFailure] = React.useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!secret) {
        setFailure('This review link is malformed. Request a fresh link and open it again.');
        return;
      }
      try {
        await signInWithReviewSecret(secret);
        if (!cancelled) router.replace('/beeline/channels');
      } catch {
        if (!cancelled)
          setFailure('This review link is invalid or expired. Request a fresh link and try again.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [secret]);

  return (
    <View style={styles.container}>
      {failure ? (
        <View accessibilityRole="alert" style={styles.failure} testID="review-sign-in-error">
          <Text style={styles.failureTitle}>Review sign-in failed</Text>
          <Text style={styles.failureText}>{failure}</Text>
          <MonoButton
            label="Return to sign in"
            onPress={() => router.replace('/beeline/onboarding')}
            variant="secondary"
          />
        </View>
      ) : (
        <>
          <PixelLoader compact />
          <Text style={styles.status}>signing in…</Text>
        </>
      )}
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
  failure: { width: '100%', maxWidth: 440, paddingHorizontal: 24 },
  failureTitle: {
    ...theme.buzz.type.hero,
    color: theme.buzz.textPrimary,
    textAlign: 'center',
  },
  failureText: {
    ...theme.buzz.type.body,
    color: theme.buzz.textSecondary,
    marginVertical: theme.buzz.space.lg,
    textAlign: 'center',
  },
}));
