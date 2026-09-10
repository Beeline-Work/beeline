import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useIsTablet, useHeaderHeight } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { useWindowDimensions, View, Pressable, Platform, PanResponder } from 'react-native';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { isTauri } from '@/utils/isTauri';
import { DEFAULT_APP_ZOOM } from '@/hooks/useTauriZoom';
import {
  canRouteForward,
  canUseRouteBack,
  getNavigatorCanGoBack,
} from '@/navigation/browserNavigation';
import { useBrowserNavigationStore } from '@/navigation/browserNavigationStore';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { monolithSession } from '@/auth/monolith-session';
import {
  showsDesktopSessionChrome,
  type DesktopSessionState,
  usesPersistentDesktopFrame,
} from './desktop-shell-policy';
import { isDesktopPlatform } from '@/utils/platform';
import {
  clampDesktopPaneWidth,
  DESKTOP_NAV_DEFAULT_WIDTH,
  loadDesktopPaneWidth,
  saveDesktopPaneWidth,
} from '@/buzz/desktop-workbench-state';

const TAURI_HEADER_CONTROL_LEFT = Math.ceil(92 / DEFAULT_APP_ZOOM);

export const SidebarNavigator = React.memo(() => {
  const isTablet = useIsTablet();
  const inDesktopShell = isTauri();
  const desktopPlatform = isDesktopPlatform();
  const pathname = usePathname();
  const zenMode = useLocalSetting('zenMode');
  const [desktopSession, setDesktopSession] = React.useState<DesktopSessionState>(
    inDesktopShell ? 'checking' : 'signed-in',
  );
  const isDesktopLayout = usesPersistentDesktopFrame(desktopPlatform, isTablet);
  const isAppSurface = pathname.startsWith('/beeline/') && !pathname.includes('/onboarding');
  const showSessionChrome =
    isAppSurface &&
    showsDesktopSessionChrome(inDesktopShell, desktopPlatform || isTablet, desktopSession);
  const showSidebar = showSessionChrome && !zenMode;
  const { width: windowWidth } = useWindowDimensions();

  React.useEffect(() => {
    if (!inDesktopShell) return;
    let cancelled = false;
    const refresh = () => {
      void Promise.all([monolithSession.identityId(), loadBuzzIdentity()])
        .then(([identityId, legacyIdentity]) => {
          if (!cancelled)
            setDesktopSession(identityId || legacyIdentity ? 'signed-in' : 'signed-out');
        })
        .catch(() => {
          if (!cancelled) setDesktopSession('signed-out');
        });
    };
    refresh();
    const unsubscribe = monolithSession.subscribeIdentityChange(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [inDesktopShell, pathname]);

  const [storedDrawerWidth, setStoredDrawerWidth] = React.useState(DESKTOP_NAV_DEFAULT_WIDTH);
  const dragStartWidth = React.useRef(storedDrawerWidth);
  React.useEffect(() => {
    if (!desktopPlatform) return;
    void loadDesktopPaneWidth('navigation').then(setStoredDrawerWidth);
  }, [desktopPlatform]);
  const fullDrawerWidth = isDesktopLayout
    ? clampDesktopPaneWidth('navigation', Math.min(storedDrawerWidth, windowWidth - 440))
    : DESKTOP_NAV_DEFAULT_WIDTH;
  const drawerWidth = showSidebar ? fullDrawerWidth : 0;
  const resizePan = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => desktopPlatform && showSidebar,
        onMoveShouldSetPanResponder: (_, gesture) => desktopPlatform && Math.abs(gesture.dx) > 2,
        onPanResponderGrant: () => {
          dragStartWidth.current = fullDrawerWidth;
        },
        onPanResponderMove: (_, gesture) =>
          setStoredDrawerWidth(
            clampDesktopPaneWidth('navigation', dragStartWidth.current + gesture.dx),
          ),
        onPanResponderRelease: (_, gesture) => {
          const width = clampDesktopPaneWidth('navigation', dragStartWidth.current + gesture.dx);
          setStoredDrawerWidth(width);
          void saveDesktopPaneWidth('navigation', width);
        },
      }),
    [desktopPlatform, fullDrawerWidth, showSidebar],
  );

  const drawerNavigationOptions = React.useMemo(() => {
    if (!isDesktopLayout) {
      // Non-tablet: use front drawer, hidden
      return {
        lazy: false,
        headerShown: false,
        drawerType: 'front' as const,
        swipeEnabled: false,
        drawerStyle: {
          width: 0,
          display: 'none' as const,
        },
      };
    }

    // Tablet: always permanent, just collapse width in zen mode.
    //
    // We deliberately do NOT animate `width` on web. A CSS transition on
    // the drawer width re-flowed the chat flex-1 sibling on every frame,
    // re-measuring the entire FlatList tree at ~15fps. Snapping the
    // width change makes the chat reflow exactly once. Native already
    // snaps because RN doesn't honor CSS transition properties.
    return {
      lazy: false,
      headerShown: false,
      drawerType: 'permanent' as const,
      drawerStyle: {
        backgroundColor: 'white',
        borderRightWidth: 0,
        width: drawerWidth,
        overflow: 'hidden' as const,
      } as any,
      swipeEnabled: false,
      drawerActiveTintColor: 'transparent',
      drawerInactiveTintColor: 'transparent',
      drawerItemStyle: { display: 'none' as const },
      drawerLabelStyle: { display: 'none' as const },
    };
  }, [isDesktopLayout, drawerWidth]);

  const drawerContent = React.useCallback(() => <SidebarView />, []);

  return (
    <View style={{ flex: 1 }}>
      {/* DOM order follows the desktop's spatial reading order. */}
      {showSessionChrome && <PersistentHeader />}
      <Drawer
        screenOptions={drawerNavigationOptions}
        drawerContent={showSessionChrome ? drawerContent : undefined}
      />
      {desktopPlatform && showSidebar && (
        <View
          {...resizePan.panHandlers}
          accessibilityLabel="Resize navigation pane"
          style={
            {
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: drawerWidth - 3,
              width: 7,
              cursor: 'col-resize',
              zIndex: 1200,
            } as any
          }
          testID="desktop-navigation-resizer"
        />
      )}
    </View>
  );
});

// Header block that stays in the same position whether zen mode is on or off
const PersistentHeader = React.memo(() => {
  const { theme } = useUnistyles();
  const safeArea = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const router = useRouter();
  const [zenMode, setZenMode] = useLocalSettingMutable('zenMode');
  const inTauri = isTauri();
  const isMacTauri = inTauri && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

  const routeHistory = useBrowserNavigationStore((s) => s.routeHistory);
  const canGoForward = useBrowserNavigationStore((s) =>
    s.routeHistory ? canRouteForward(s.routeHistory) : false,
  );
  const canGoBack = routeHistory
    ? canUseRouteBack(routeHistory, getNavigatorCanGoBack(router))
    : false;

  const handleZenToggle = React.useCallback(() => {
    setZenMode(!zenMode);
  }, [zenMode, setZenMode]);

  const handleBack = React.useCallback(() => {
    const nav = useBrowserNavigationStore.getState();
    if (!nav.routeHistory || !canUseRouteBack(nav.routeHistory, getNavigatorCanGoBack(router)))
      return;
    nav.markRouteBack();
    router.back();
  }, [router]);

  const handleForward = React.useCallback(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const nav = useBrowserNavigationStore.getState();
      if (!nav.routeHistory || !canRouteForward(nav.routeHistory)) return;
      nav.markRouteForward();
      window.history.forward();
    }
  }, []);

  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        paddingTop: safeArea.top,
        paddingLeft: isMacTauri ? TAURI_HEADER_CONTROL_LEFT : 16,
        paddingRight: 16,
        height: safeArea.top + headerHeight,
        flexDirection: 'row',
        alignItems: 'center',
        zIndex: 1100,
      }}
      pointerEvents="box-none"
      {...(inTauri ? { dataSet: { tauriDragRegion: 'true' } } : {})}
    >
      {/* Zen / Back / Forward buttons */}
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
        pointerEvents="auto"
        {...(inTauri ? { dataSet: { tauriDragRegion: 'false' } } : {})}
      >
        <Pressable
          onPress={handleZenToggle}
          hitSlop={10}
          style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
          accessibilityLabel={t('zen.toggle')}
        >
          <Image
            source={require('@/assets/images/zen-icon.png')}
            contentFit="contain"
            style={{ width: 18, height: 18 }}
            tintColor={zenMode ? theme.colors.textLink : theme.colors.header.tint}
          />
        </Pressable>
        <Pressable
          focusable={canGoBack}
          tabIndex={canGoBack ? 0 : -1}
          onPress={handleBack}
          disabled={!canGoBack}
          hitSlop={10}
          style={{
            width: 28,
            height: 28,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: canGoBack ? 1 : 0.3,
          }}
        >
          <Ionicons name="chevron-back" size={20} color={theme.colors.header.tint} />
        </Pressable>
        {Platform.OS === 'web' && (
          <Pressable
            focusable={canGoForward}
            tabIndex={canGoForward ? 0 : -1}
            onPress={handleForward}
            disabled={!canGoForward}
            hitSlop={10}
            style={{
              width: 28,
              height: 28,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: canGoForward ? 1 : 0.3,
            }}
          >
            <Ionicons name="chevron-forward" size={20} color={theme.colors.header.tint} />
          </Pressable>
        )}
      </View>
    </View>
  );
});
