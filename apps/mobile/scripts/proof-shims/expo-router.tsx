// Native proof stand-in for expo-router: one screen at a time, params from the proof's own store.
import React from 'react';

type Listener = () => void;
let params: Record<string, string> = {};
const listeners = new Set<Listener>();
export const proofNavigation: { calls: string[] } = { calls: [] };

export function setProofParams(next: Record<string, string>) {
  params = next;
  for (const listener of listeners) listener();
}

export function useLocalSearchParams() {
  const [, rerender] = React.useState(0);
  React.useEffect(() => {
    const listener = () => rerender((value) => value + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return params;
}
export const useGlobalSearchParams = useLocalSearchParams;
export const useFocusEffect = (effect: () => void | (() => void)) => React.useEffect(effect, [effect]);
export const useRouter = () => router;
export const usePathname = () => '/proof';
export const useSegments = () => [];
export const useNavigation = () => ({ addListener: () => () => undefined, setOptions: () => undefined });
export const router = {
  back: () => { proofNavigation.calls.push('back'); },
  push: (href: unknown) => { proofNavigation.calls.push(`push ${JSON.stringify(href)}`); },
  replace: (href: unknown) => { proofNavigation.calls.push(`replace ${JSON.stringify(href)}`); },
  navigate: (href: unknown) => { proofNavigation.calls.push(`navigate ${JSON.stringify(href)}`); },
  canGoBack: () => false,
};
export const Link = ({ children }: { children: React.ReactNode }) => <>{children}</>;
export const Stack = Object.assign(() => null, { Screen: () => null });
export type Href = unknown;
