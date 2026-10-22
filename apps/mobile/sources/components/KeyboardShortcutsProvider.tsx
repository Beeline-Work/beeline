import React, { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useGlobalKeyboard } from '@/hooks/useGlobalKeyboard';
import { ShortcutHintsProvider } from '@/components/ShortcutHints';
import { isTauri } from '@/utils/isTauri';

const EMPTY_SESSION_IDS: readonly string[] = [];

export function KeyboardShortcutsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const browserSafeShortcuts = useMemo(() => Platform.OS === 'web' && !isTauri(), []);

  const openRooms = useCallback(() => {
    router.navigate('/beeline/channels');
  }, [router]);

  const openSettings = useCallback(() => {
    router.push('/beeline/settings');
  }, [router]);

  const visibleModifier = useGlobalKeyboard(
    {
      newSession: openRooms,
      settings: openSettings,
    },
    browserSafeShortcuts,
  );

  return (
    <ShortcutHintsProvider
      modifier={visibleModifier}
      recentSessionIds={EMPTY_SESSION_IDS}
      browserSafeShortcuts={browserSafeShortcuts}
    >
      {children}
    </ShortcutHintsProvider>
  );
}
