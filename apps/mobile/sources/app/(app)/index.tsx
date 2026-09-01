import { RoundButton } from '@/components/RoundButton';
import { Text, View } from 'react-native';
import * as React from 'react';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { parseCommunityInviteToken } from '@/buzz/community-invite';
import { isPersonNameOnboardingPending } from '@/buzz/person-name';

export default function Home() {
  const [buzzCheckDone, setBuzzCheckDone] = React.useState(false);
  const [hasBuzzIdentity, setHasBuzzIdentity] = React.useState(false);
  const [initialInviteToken, setInitialInviteToken] = React.useState<string | null>(null);
  const [personNameOnboardingPending, setPersonNameOnboardingPending] = React.useState(false);
  const [buzzStorageError, setBuzzStorageError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void Promise.all([loadBuzzIdentity(), Linking.getInitialURL().catch(() => null)])
      .then(async ([identity, initialUrl]) => {
        setHasBuzzIdentity(identity !== null);
        setPersonNameOnboardingPending(identity ? await isPersonNameOnboardingPending() : false);
        setInitialInviteToken(parseCommunityInviteToken(initialUrl ?? undefined));
        setBuzzCheckDone(true);
      })
      .catch((err: unknown) => {
        setBuzzStorageError(String(err));
        setBuzzCheckDone(true);
      });
  }, []);

  React.useEffect(() => {
    if (!buzzCheckDone || buzzStorageError) return;

    if (initialInviteToken) {
      router.replace({
        pathname: '/join/[token]',
        params: { token: initialInviteToken },
      });
    } else if (hasBuzzIdentity && !personNameOnboardingPending) {
      router.replace('/beeline/channels');
    } else {
      router.replace('/beeline/onboarding');
    }
  }, [
    buzzCheckDone,
    buzzStorageError,
    hasBuzzIdentity,
    initialInviteToken,
    personNameOnboardingPending,
  ]);

  // Wait for the async identity check before rendering.
  if (!buzzCheckDone) {
    return null;
  }

  if (buzzStorageError) {
    return (
      <View style={styles.portraitContainer}>
        <Text style={styles.title}>Secure storage unavailable</Text>
        <Text accessibilityRole="alert" style={styles.subtitle}>
          Beeline could not read your saved key: {buzzStorageError}
        </Text>
        <View style={styles.buttonContainer}>
          <RoundButton
            title="Open Beeline setup"
            onPress={() => router.push('/beeline/onboarding')}
          />
        </View>
      </View>
    );
  }

  // Beeline owns the app root. The replace keeps back navigation from revealing
  // The app entry always resolves through Beeline identity state.
  return null;
}

const styles = StyleSheet.create((theme) => ({
  portraitContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    marginTop: 16,
    textAlign: 'center',
    fontSize: 24,
    ...Typography.default('semiBold'),
    fontFamily: theme.buzz.proseSemibold,
    color: theme.colors.text,
  },
  subtitle: {
    ...Typography.default(),
    fontFamily: theme.buzz.proseRegular,
    fontSize: 18,
    color: theme.colors.textSecondary,
    marginTop: 16,
    textAlign: 'center',
    marginHorizontal: 24,
    marginBottom: 64,
  },
  buttonContainer: {
    maxWidth: 280,
    width: '100%',
    marginBottom: 16,
  },
}));
