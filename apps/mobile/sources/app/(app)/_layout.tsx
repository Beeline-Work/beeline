import { Stack } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { createHeader } from '@/components/navigation/Header';
import { Platform, View } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { useUnistyles } from 'react-native-unistyles';
import { statusBarStyleForTheme } from '@/components/StatusBarProvider';
import { t } from '@/text';
import { useIsDesktop } from '@/utils/responsive';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function RootLayout() {
  // Keep UIKit in charge of iPhone/iPad headers. A custom React header makes
  // native-stack animate every blur/glass subview during each push and pop.
  const isDesktop = useIsDesktop();
  const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || isDesktop;
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
          // Status bar glyphs follow the app theme: dark icons over Bone,
          // light icons over Obsidian, on every platform the stack runs on.
          // Per-screen overrides were dropped — the theme is the one author.
          statusBarStyle: statusBarStyleForTheme(theme),
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
          }}
        />
        <Stack.Screen name="buzz/github-callback" options={{ headerShown: false }} />
        <Stack.Screen name="buzz/github-installation" options={{ headerShown: false }} />
        <Stack.Screen name="beeline/github-callback" options={{ headerShown: false }} />
        <Stack.Screen name="beeline/github-installation" options={{ headerShown: false }} />
        <Stack.Screen
          name="beeline/channels"
          options={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.buzz.bgBase },
          }}
        />
        <Stack.Screen
          name="beeline/bookmarks"
          options={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.buzz.bgBase },
          }}
        />
        <Stack.Screen
          name="beeline/community"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="beeline/agents"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="beeline/members"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="beeline/settings/index"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="beeline/settings/identity"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="beeline/settings/workspace"
          options={{
            headerShown: false,
          }}
        />
        {/* Scheduled work keeps the stack header (its back control); the page draws none. */}
        <Stack.Screen
          name="beeline/settings/schedules"
          options={{
            headerTitle: 'Scheduled work',
          }}
        />
        <Stack.Screen
          name="beeline/settings/workflows"
          options={{
            headerTitle: 'Workflows',
          }}
        />
        {/* Workbench keeps the stack header (its back control) on a phone; on
            desktop the page draws the shared PageHeader so its title lines up
            with the other sections. */}
        <Stack.Screen
          name="beeline/settings/workbench"
          options={{
            headerShown: !isDesktop,
            headerTitle: 'Workbench',
          }}
        />
        {/* The connect flow draws its own header with the connector name, so the
            stack header would double it. Wallet uses the same in-page header. */}
        <Stack.Screen name="beeline/settings/workbench/wallet" options={{ headerShown: false }} />
        <Stack.Screen name="beeline/settings/workbench/connect" options={{ headerShown: false }} />
        {/* The Squire sign-in browser renders as an overlay card over the
            connect screen — most of the screen, never full-bleed, with the
            underlying screen frosted behind it. */}
        <Stack.Screen
          name="beeline/settings/workbench/connect-signin"
          options={{ headerShown: false, presentation: 'transparentModal' }}
        />
        <Stack.Screen
          name="beeline/chat/[channelId]"
          options={{
            headerShown: false,
            animation: 'none',
            contentStyle: { backgroundColor: theme.buzz.bgBase },
          }}
        />
        <Stack.Screen
          name="beeline/corners/[roomId]"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="join/[token]"
          options={{
            headerShown: false,
          }}
        />
        {/* The store-reviewer links' landing route. No in-app control opens it. */}
        <Stack.Screen
          name="review/[secret]"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="settings/index"
          options={{
            headerShown: false,
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
          }}
        />
        <Stack.Screen name="artifact-viewer" options={{ headerShown: false }} />
        <Stack.Screen name="beeline/corner-app/[slug]" options={{ headerShown: false }} />
        <Stack.Screen
          name="text-selection"
          options={{
            headerShown: true,
            headerTitle: t('textSelection.title'),
            headerBackTitle: t('common.back'),
          }}
        />
      </Stack>
    </View>
  );
}
