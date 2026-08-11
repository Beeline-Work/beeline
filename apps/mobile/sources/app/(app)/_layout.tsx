import { Stack } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Typography } from '@/constants/Typography';
import { createHeader } from '@/components/navigation/Header';
import { Platform, View } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { MobileGlassBackdrop } from '@/components/MobileGlass';

export const unstable_settings = {
    initialRouteName: 'index',
};

export default function RootLayout() {
    // Keep UIKit in charge of iPhone/iPad headers. A custom React header makes
    // native-stack animate every blur/glass subview during each push and pop.
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const isDesktop = Platform.OS === 'web' || isRunningOnMac();
    const { theme } = useUnistyles();

    return (
        <View
            style={{
                flex: 1,
                backgroundColor: isDesktop
                    ? theme.colors.surface
                    : theme.colors.groupped.background,
            }}
        >
            <MobileGlassBackdrop enabled={!isDesktop} />
        <Stack
            initialRouteName='index'
            screenOptions={{
                header: shouldUseCustomHeader ? createHeader : undefined,
                headerBackTitle: t('common.back'),
                headerBackButtonDisplayMode: Platform.OS === 'ios' ? 'minimal' : undefined,
                headerShadowVisible: false,
                contentStyle: {
                    backgroundColor: isDesktop
                        ? theme.colors.surface
                        : theme.colors.groupped.background,
                },
                headerStyle: {
                    backgroundColor: isDesktop ? theme.colors.header.background : 'transparent',
                },
                headerTintColor: theme.colors.header.tint,
                headerTitleStyle: {
                    color: theme.colors.header.tint,
                    ...Typography.default('semiBold'),
                },

            }}
        >
            <Stack.Screen
                name="index"
                options={{
                    headerShown: false,
                    headerTitle: ''
                }}
            />
            {/* Buzz identity screens — parallel minimal path using BuzzRigTransport directly */}
            <Stack.Screen
                name="buzz/onboarding"
                options={{
                    headerShown: false,
                    statusBarStyle: 'light',
                }}
            />
            <Stack.Screen
                name="buzz/oidc-callback"
                options={{ headerShown: false, statusBarStyle: 'light' }}
            />
            <Stack.Screen
                name="buzz/channels"
                options={{
                    headerShown: false,
                    statusBarStyle: 'light',
                }}
            />
            <Stack.Screen
                name="buzz/community"
                options={{
                    headerShown: false,
                    statusBarStyle: 'light',
                }}
            />
            <Stack.Screen
                name="buzz/agents"
                options={{
                    headerShown: false,
                    statusBarStyle: 'light',
                }}
            />
            <Stack.Screen
                name="buzz/settings/identity"
                options={{
                    headerShown: false,
                    statusBarStyle: 'light',
                }}
            />
            <Stack.Screen
                name="buzz/chat/[channelId]"
                options={{
                    headerShown: false,
                    statusBarStyle: 'light',
                }}
            />
            <Stack.Screen
                name="buzz/corners/[roomId]"
                options={{
                    headerShown: false,
                    statusBarStyle: 'light',
                }}
            />
            <Stack.Screen
                name="join/[token]"
                options={{
                    headerShown: false,
                    statusBarStyle: 'light',
                }}
            />
            <Stack.Screen
                name="settings/index"
                options={{
                    headerShown: true,
                    headerTitle: t('settings.title'),
                    headerBackTitle: t('common.home')
                }}
            />
            <Stack.Screen
                name="session/[id]"
                options={{
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="session/[id]/message/[messageId]"
                options={{
                    headerShown: true,
                    headerBackTitle: t('common.back'),
                    headerTitle: t('common.message')
                }}
            />
            <Stack.Screen
                name="session/[id]/info"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/files"
                options={{
                    headerShown: true,
                    headerTitle: t('common.files'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/file"
                options={{
                    headerShown: true,
                    headerTitle: t('common.fileViewer'),
                    headerBackTitle: t('common.files'),
                }}
            />
            <Stack.Screen
                name="settings/appearance"
                options={{
                    headerTitle: t('settings.appearance'),
                }}
            />
            <Stack.Screen
                name="settings/agents"
                options={{
                    headerTitle: 'Agent Defaults',
                }}
            />
            <Stack.Screen
                name="settings/features"
                options={{
                    headerTitle: t('settings.features'),
                }}
            />
            <Stack.Screen
                name="changelog"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.whatsNew'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="text-selection"
                options={{
                    headerShown: true,
                    headerTitle: t('textSelection.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/index"
                options={{
                    headerTitle: t('newSession.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
        </Stack>
        </View>
    );
}
