import { RoundButton } from "@/components/RoundButton";
import { Text, View } from "react-native";
import * as React from 'react';
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { Typography } from "@/constants/Typography";
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';

export default function Home() {
    const [buzzCheckDone, setBuzzCheckDone] = React.useState(false);
    const [hasBuzzIdentity, setHasBuzzIdentity] = React.useState(false);
    const [buzzStorageError, setBuzzStorageError] = React.useState<string | null>(null);

    React.useEffect(() => {
        void loadBuzzIdentity()
            .then((identity) => {
                setHasBuzzIdentity(identity !== null);
                setBuzzCheckDone(true);
            })
            .catch((err: unknown) => {
                setBuzzStorageError(String(err));
                setBuzzCheckDone(true);
            });
    }, []);

    React.useEffect(() => {
        if (!buzzCheckDone || buzzStorageError) return;

        if (hasBuzzIdentity) {
            router.replace('/buzz/channels');
        } else {
            router.replace('/buzz/onboarding');
        }
    }, [buzzCheckDone, buzzStorageError, hasBuzzIdentity]);

    // Wait for the async buzz check before rendering.
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
                        title="Open Buzz setup"
                        onPress={() => router.push('/buzz/onboarding')}
                    />
                </View>
            </View>
        );
    }

    // Buzz owns the app root. The replace keeps back navigation from revealing
    // Happy's retired account landing, including for upgraded authenticated devices.
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
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
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
