import { Stack } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { createHeader } from '@/components/navigation/Header';
import { Platform, View } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function RootLayout() {
  // Keep UIKit in charge of iPhone/iPad headers. A custom React header makes
  // native-stack animate every blur/glass subview during each push and pop.
  const shouldUseCustomHeader =
    Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
  const isDesktop = Platform.OS === 'web' || isRunningOnMac();
  const { theme } = useUnistyles();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: isDesktop ? theme.colors.surface : theme.colors.groupped.background,
      }}
    >
      <Stack
        initialRouteName="index"
        screenOptions={{
          header: shouldUseCustomHeader ? createHeader : undefined,
          headerBackTitle: t('common.back'),
          headerBackButtonDisplayMode: Platform.OS === 'ios' ? 'minimal' : undefined,
          headerShadowVisible: false,
          contentStyle: {
            backgroundColor: isDesktop ? theme.colors.surface : theme.colors.groupped.background,
          },
          headerStyle: {
            backgroundColor: isDesktop ? theme.colors.header.background : 'transparent',
          },
          headerTintColor: theme.colors.header.tint,
          headerTitleStyle: {
            color: theme.colors.header.tint,
            fontFamily: theme.buzz.proseSemibold,
          },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            headerShown: false,
            headerTitle: '',
          }}
        />
        {/* Beeline identity screens. The legacy callback routes remain during migration. */}
        <Stack.Screen
          name="beeline/onboarding"
          options={{
            headerShown: false,
            statusBarStyle: 'light',
          }}
        />
        <Stack.Screen
          name="buzz/github-callback"
          options={{ headerShown: false, statusBarStyle: 'light' }}
        />
        <Stack.Screen
          name="buzz/github-installation"
          options={{ headerShown: false, statusBarStyle: 'light' }}
        />
        <Stack.Screen
          name="beeline/github-callback"
          options={{ headerShown: false, statusBarStyle: 'light' }}
        />
        <Stack.Screen
          name="beeline/github-installation"
          options={{ headerShown: false, statusBarStyle: 'light' }}
        />
        <Stack.Screen
          name="beeline/channels"
          options={{
            headerShown: false,
            statusBarStyle: 'light',
            contentStyle: { backgroundColor: theme.buzz.bgBase },
          }}
        />
        <Stack.Screen
          name="beeline/community"
          options={{
            headerShown: false,
            statusBarStyle: 'light',
          }}
        />
        <Stack.Screen
          name="beeline/agents"
          options={{
            headerShown: false,
            statusBarStyle: 'light',
          }}
        />
        <Stack.Screen
          name="beeline/members"
          options={{
            headerShown: false,
            statusBarStyle: 'light',
          }}
        />
        <Stack.Screen
          name="beeline/MembersScreen"
          options={{
            headerShown: false,
            statusBarStyle: 'light',
          }}
        />
        <Stack.Screen
          name="beeline/settings/index"
          options={{
            headerShown: false,
            statusBarStyle: 'light',
          }}
        />
        <Stack.Screen
          name="beeline/settings/identity"
          options={{
            headerShown: false,
            statusBarStyle: 'light',
          }}
        />
        <Stack.Screen
          name="beeline/settings/workspace"
          options={{
            headerShown: false,
            statusBarStyle: 'light',
          }}
        />
        <Stack.Screen
          name="beeline/chat/[channelId]"
          options={{
            headerShown: false,
            statusBarStyle: 'light',
            contentStyle: { backgroundColor: theme.buzz.bgBase },
          }}
        />
        <Stack.Screen
          name="beeline/corners/[roomId]"
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
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="settings/appearance"
          options={{
            headerTitle: t('settings.appearance'),
          }}
        />
        <Stack.Screen
          name="settings/language"
          options={{
            headerTitle: t('settingsLanguage.title'),
          }}
        />
        <Stack.Screen
          name="changelog"
          options={{
            headerShown: false,
            statusBarStyle: 'light',
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
            headerShown: false,
          }}
        />
      </Stack>
    </View>
  );
}
