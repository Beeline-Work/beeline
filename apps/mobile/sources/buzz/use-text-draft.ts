import { NavigationContext } from '@react-navigation/core';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDraftIdentity } from './draft-identity';
import { TextDraft, textDraftKey } from './text-draft-store';

/** React state updates immediately; storage is asynchronous and debounced. */
export function useTextDraft<T extends string | string[]>(
  context: string | null,
  initial: T,
  explicitIdentity?: string | null,
  legacyKey?: string,
) {
  type Value = T extends string ? string : string[];
  const defaultValue = initial as unknown as Value;
  const navigation = useContext(NavigationContext);
  const identity = useDraftIdentity(explicitIdentity);
  const key = identity && context ? textDraftKey(identity, context) : null;
  const previous = useRef<{ draft: TextDraft<Value>; context: string | null } | null>(null);
  const hadIdentity = useRef(false);
  const draft = useMemo(() => {
    const old = previous.current;
    const firstIdentity = key && !hadIdentity.current && old?.context === context;
    const next = new TextDraft(
      key, AsyncStorage,
      firstIdentity && !old.draft.hasEdits ? old.draft.value : defaultValue,
      legacyKey,
    );
    // Preserve typing during the first public-identity read, never across accounts.
    if (firstIdentity && old.draft.hasEdits) {
      next.set(old.draft.value);
    }
    if (key) hadIdentity.current = true;
    previous.current = { draft: next, context };
    return next;
  }, [key, context]);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const setValue = useCallback((update: Value | ((previous: Value) => Value)) => {
    currentDraft.current.set(update);
  }, []);
  const [state, setState] = useState({ draft, value: draft.value });
  useEffect(() => {
    const unsubscribe = draft.subscribe(() => setState({ draft, value: draft.value }));
    setState({ draft, value: draft.value });
    void draft.hydrate();
    const subscription = AppState.addEventListener('change', (status) => {
      if (status !== 'active') void draft.flush();
    });
    const flush = () => {
      void draft.flush();
    };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
      window.addEventListener('pagehide', flush);
    return () => {
      unsubscribe();
      subscription.remove();
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function')
        window.removeEventListener('pagehide', flush);
      draft.dispose();
    };
  }, [draft]);
  useEffect(
    () =>
      navigation?.addListener('blur', () => {
        void draft.flush();
      }),
    [navigation, draft],
  );
  return [state.draft === draft ? state.value : draft.value, setValue, draft] as const;
}
