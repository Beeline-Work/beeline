import { useEffect } from 'react';
const noop = () => {};
const navigation = {
  isFocused: () => true,
  addListener: () => noop,
  setOptions: noop,
  canGoBack: () => false,
  getState: () => ({ routes: [] }),
};
export const router = { push: noop, replace: noop, back: noop, canGoBack: () => false };
export const useLocalSearchParams = () => ({
  channelId: 'f1a3d389-4adb-4e91-8e3d-d5f2171a84f6',
  communityId: 'f0b23d83-96a5-4ca4-9a46-fc8e3c1e82a1',
});
export const useIsFocused = () => true;
export const useNavigation = () => navigation;
export const useFocusEffect = (callback) => useEffect(callback, [callback]);
