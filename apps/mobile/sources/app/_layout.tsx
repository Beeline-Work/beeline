import 'react-native-quick-base64';
import '../theme.css';
import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';
import * as Fonts from 'expo-font';
import * as Notifications from 'expo-notifications';
import { FontAwesome } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SidebarNavigator } from '@/components/SidebarNavigator';
import { AppState, View, Platform } from 'react-native';
import { ModalProvider } from '@/modal';
import { PostHogProvider } from 'posthog-react-native';
import { tracking } from '@/track/tracking';
import { useTrackScreens } from '@/track/useTrackScreens';
import { CommandPaletteProvider } from '@/components/CommandPalette/CommandPaletteProvider';
import { StatusBarProvider } from '@/components/StatusBarProvider';
// import * as SystemUI from 'expo-system-ui';
import { initConsoleLogging, setConsoleOutputEnabled } from '@/utils/consoleLogging';
import { useLocalSetting } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { AsyncLock } from '@/utils/lock';
import { navigateToBuzzNotificationResponse } from '@/utils/notificationRouting';
import { useTauriZoom } from '@/hooks/useTauriZoom';
import { useTauriDrag } from '@/hooks/useTauriDrag';
import { BrowserNavigationShortcuts } from '@/hooks/useBrowserNavigationShortcuts';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import {
  registerBuzzPushNotifications,
  retryBuzzPushRegistration,
} from '@/push/buzz-push-registration';
import type { Identity } from '@beeline/buzz-client';
import { getOpenBuzzChannelId } from '@/buzz/open-room-tracker';
import { decideForegroundNotificationDisplay } from '@/push/foreground-policy';
import { UpdateProvider } from '@/hooks/useUpdates';
import { UpdateReadyPrompt } from '@/components/UpdateReadyPrompt';

// Foreground banner policy: suppress banners while the app is active, and
// always for the Room the person currently has open. Background display and
// response routing are untouched; see push/foreground-policy.ts.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const decision = decideForegroundNotificationDisplay({
      appState: AppState.currentState,
      openChannelId: getOpenBuzzChannelId(),
      data: notification.request.content.data,
    });
    return {
      shouldShowAlert: decision.shouldPresent,
      shouldPlaySound: decision.shouldPresent,
      shouldSetBadge: true,
      shouldShowBanner: decision.shouldPresent,
      // Keep suppressed notifications in the notification list/tray so they
      // remain discoverable after the fact without interrupting the screen.
      shouldShowList: true,
    };
  },
});

// Setup Android notification channels (required for Android 8.0+)
if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('default', {
    name: 'Default',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#FF231F7C',
  });
  Notifications.setNotificationChannelAsync('mentions', {
    name: 'Mentions',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#FF231F7C',
  });
  Notifications.setNotificationChannelAsync('attention', {
    name: 'Agent attention',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#FF231F7C',
  });
  Notifications.setNotificationChannelAsync('activity', {
    name: 'Direct messages',
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: '#FF231F7C',
  });
}

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

// Configure splash screen
SplashScreen.setOptions({
  fade: true,
  duration: 300,
});
SplashScreen.preventAutoHideAsync();

// Set window background color - now handled by Unistyles
// SystemUI.setBackgroundColorAsync('white');

// Remote logging to local log server (configured via Dev > Log Server setting)
initConsoleLogging();

// Component to apply horizontal safe area padding
function HorizontalSafeAreaWrapper({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flex: 1,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      {children}
    </View>
  );
}

let lock = new AsyncLock();
let loaded = false;

function stringifyNotificationPayload(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? String(value);
  } catch (error) {
    return `[unserializable notification payload: ${error instanceof Error ? error.message : 'Unknown error'}]`;
  }
}

async function loadFonts() {
  await lock.inLock(async () => {
    if (loaded) {
      return;
    }
    loaded = true;
    // Check if running in Tauri
    const isTauri =
      Platform.OS === 'web' &&
      typeof window !== 'undefined' &&
      (window as any).__TAURI_INTERNALS__ !== undefined;

    if (!isTauri) {
      // Normal font loading for non-Tauri environments (native and regular web)
      await Fonts.loadAsync({
        // IBM Plex Sans family
        'IBMPlexSans-Regular': require('@/assets/fonts/IBMPlexSans-Regular.ttf'),
        'IBMPlexSans-Italic': require('@/assets/fonts/IBMPlexSans-Italic.ttf'),
        'IBMPlexSans-SemiBold': require('@/assets/fonts/IBMPlexSans-SemiBold.ttf'),

        // IBM Plex Serif family (Editorial Ink prose)
        'IBMPlexSerif-Regular': require('@/assets/fonts/IBMPlexSerif-Regular.ttf'),
        'IBMPlexSerif-Italic': require('@/assets/fonts/IBMPlexSerif-Italic.ttf'),
        'IBMPlexSerif-SemiBold': require('@/assets/fonts/IBMPlexSerif-SemiBold.ttf'),

        // IBM Plex Mono family
        'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
        'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
        'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),

        // Space Grotesk family (Editorial transcript prose)
        'SpaceGrotesk-Regular': require('@/assets/fonts/SpaceGrotesk-Regular.ttf'),
        'SpaceGrotesk-Medium': require('@/assets/fonts/SpaceGrotesk-Medium.ttf'),
        'SpaceGrotesk-SemiBold': require('@/assets/fonts/SpaceGrotesk-SemiBold.ttf'),

        // Bricolage Grotesque
        'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),

        ...FontAwesome.font,
      });
    } else {
      // For Tauri, skip Font Face Observer as fonts are loaded via CSS
      console.log('Do not wait for fonts to load');
      (async () => {
        try {
          await Fonts.loadAsync({
            // IBM Plex Sans family
            'IBMPlexSans-Regular': require('@/assets/fonts/IBMPlexSans-Regular.ttf'),
            'IBMPlexSans-Italic': require('@/assets/fonts/IBMPlexSans-Italic.ttf'),
            'IBMPlexSans-SemiBold': require('@/assets/fonts/IBMPlexSans-SemiBold.ttf'),

            // IBM Plex Serif family (Editorial Ink prose)
            'IBMPlexSerif-Regular': require('@/assets/fonts/IBMPlexSerif-Regular.ttf'),
            'IBMPlexSerif-Italic': require('@/assets/fonts/IBMPlexSerif-Italic.ttf'),
            'IBMPlexSerif-SemiBold': require('@/assets/fonts/IBMPlexSerif-SemiBold.ttf'),

            // IBM Plex Mono family
            'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
            'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
            'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),

            // Space Grotesk family (Editorial transcript prose)
            'SpaceGrotesk-Regular': require('@/assets/fonts/SpaceGrotesk-Regular.ttf'),
            'SpaceGrotesk-Medium': require('@/assets/fonts/SpaceGrotesk-Medium.ttf'),
            'SpaceGrotesk-SemiBold': require('@/assets/fonts/SpaceGrotesk-SemiBold.ttf'),

            // Bricolage Grotesque
            'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),

            ...FontAwesome.font,
          });
        } catch (e) {
          // Ignore
        }
      })();
    }
  });
}

export default function RootLayout() {
  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      // MMKV is synchronous and a warm-cache snapshot may be large, so
      // this is deliberately the only write point: after Android has
      // already transitioned away from the foreground. A deferred JS
      // timer cannot be used here—Android suspends that timer before it
      // fires, leaving a cold launch with no persisted transcript.
      if (state === 'background') {
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);

  const pushIdentityRef = React.useRef<Identity | null>(null);
  React.useEffect(() => {
    // Refresh the FCM binding on every cold start. Firebase can rotate the
    // device token long after onboarding, so registration cannot be a
    // one-time side effect of importing or creating an identity.
    void loadBuzzIdentity()
      .then((identity) => {
        if (!identity) return null;
        pushIdentityRef.current = identity;
        return registerBuzzPushNotifications(identity);
      })
      .then((result) => {
        if (result && !result.registered) {
          console.warn(
            `[buzzy-push] startup registration not completed: phase=${result.phase}${result.message ? ` (${result.message})` : ''}`,
          );
        }
      })
      .catch((error: unknown) => {
        console.warn(
          '[buzzy-push] startup registration unavailable:',
          error instanceof Error ? error.message : String(error),
        );
      });
    // A failed token acquisition or gateway POST retries with backoff when
    // the app next reaches the foreground, instead of staying dead until a
    // manual toggle. retryBuzzPushRegistration no-ops when the last attempt
    // succeeded or its backoff window has not elapsed.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const identity = pushIdentityRef.current;
      if (!identity) return;
      void retryBuzzPushRegistration(identity)
        .then((result) => {
          if (result && !result.registered) {
            console.warn(
              `[buzzy-push] foreground retry did not register: phase=${result.phase}${result.message ? ` (${result.message})` : ''}`,
            );
          }
        })
        .catch((error: unknown) => {
          console.warn(
            '[buzzy-push] foreground retry unavailable:',
            error instanceof Error ? error.message : String(error),
          );
        });
    });
    return () => {
      subscription.remove();
    };
  }, []);

  useTauriZoom();
  useTauriDrag();
  const router = useRouter();
  const { theme } = useUnistyles();
  const navigationTheme = React.useMemo(() => {
    if (theme.dark) {
      return {
        ...DarkTheme,
        colors: {
          ...DarkTheme.colors,
          background: theme.colors.groupped.background,
        },
      };
    }
    return {
      ...DefaultTheme,
      colors: {
        ...DefaultTheme.colors,
        background: theme.colors.groupped.background,
      },
    };
  }, [theme]);

  //
  // Init sequence
  //
  const [initialized, setInitialized] = React.useState(false);
  React.useEffect(() => {
    (async () => {
      try {
        await loadFonts();
        setInitialized(true);
      } catch (error) {
        console.error('Error initializing:', error);
      }
    })();
  }, []);

  React.useEffect(() => {
    if (initialized) {
      setTimeout(() => {
        SplashScreen.hideAsync();
      }, 100);
    }
  }, [initialized]);

  const handledNotificationIds = React.useRef<Set<string>>(new Set());
  const handleNotificationResponse = React.useCallback(
    async (response: Notifications.NotificationResponse | null) => {
      if (!response) {
        console.log('[PUSH ROUTING] Notification response is null');
        return;
      }

      console.log(
        '[PUSH ROUTING] Full notification response:\n' + stringifyNotificationPayload(response),
      );

      const responseId = response.notification.request.identifier;
      if (handledNotificationIds.current.has(responseId)) {
        console.log(`[PUSH ROUTING] Duplicate notification response ignored: ${responseId}`);
        return;
      }

      handledNotificationIds.current.add(responseId);

      try {
        if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
          console.log(`[PUSH ROUTING] Ignoring non-default action: ${response.actionIdentifier}`);
          return;
        }

        console.log(
          '[PUSH ROUTING] notification.request.content.data:\n' +
            stringifyNotificationPayload(response.notification.request.content.data),
        );
        const buzzTarget = navigateToBuzzNotificationResponse(router, response);
        if (buzzTarget) {
          console.log(
            `[PUSH ROUTING] Navigating to Buzz ${buzzTarget.target}: ${buzzTarget.channelId}`,
          );
          return;
        }
        console.log(
          '[PUSH ROUTING] No supported route found in notification.request.content.data',
        );
      } finally {
        try {
          await Notifications.clearLastNotificationResponseAsync();
        } catch (error) {
          console.log('Failed to clear last notification response:', error);
        }
      }
    },
    [router],
  );

  React.useEffect(() => {
    if (!initialized) {
      return;
    }

    let active = true;
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void handleNotificationResponse(response);
    });

    void (async () => {
      try {
        const response = await Notifications.getLastNotificationResponseAsync();
        if (active) {
          await handleNotificationResponse(response);
        }
      } catch (error) {
        console.log('Failed to read last notification response:', error);
      }
    })();

    return () => {
      active = false;
      subscription.remove();
    };
  }, [handleNotificationResponse, initialized]);

  // Track the screens
  useTrackScreens();

  // Sync console output toggle from Dev screen
  const consoleLoggingEnabled = useLocalSetting('consoleLoggingEnabled');
  React.useEffect(() => {
    setConsoleOutputEnabled(consoleLoggingEnabled);
  }, [consoleLoggingEnabled]);

  //
  // Not inited
  //

  if (!initialized) {
    return null;
  }

  //
  // Boot
  //

  let providers = (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <KeyboardProvider preload={false}>
        <GestureHandlerRootView
          style={
            Platform.OS === 'web'
              ? { flex: 1 }
              : { flex: 1, backgroundColor: theme.colors.groupped.background }
          }
        >
          <UpdateProvider>
            <ThemeProvider value={navigationTheme}>
              <StatusBarProvider />
              <ModalProvider>
                <BrowserNavigationShortcuts />
                <CommandPaletteProvider>
                  <HorizontalSafeAreaWrapper>
                    <SidebarNavigator />
                  </HorizontalSafeAreaWrapper>
                </CommandPaletteProvider>
              </ModalProvider>
              <UpdateReadyPrompt />
            </ThemeProvider>
          </UpdateProvider>
        </GestureHandlerRootView>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
  if (tracking) {
    providers = <PostHogProvider client={tracking}>{providers}</PostHogProvider>;
  }

  return providers;
}
