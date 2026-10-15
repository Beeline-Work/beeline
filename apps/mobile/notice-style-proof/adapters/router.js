import { useEffect } from 'react';
const noop = () => {};
const navigation = {
  addListener: () => noop,
  setOptions: noop,
  canGoBack: () => false,
  getState: () => ({ routes: [] }),
};
export const router = { push: noop, replace: noop, back: noop, canGoBack: () => false };
export const useLocalSearchParams = () => ({
  channelId: 'dac9d764-e14e-4ca0-b263-cda37ffa737a',
  communityId: 'f0b23d83-96a5-4ca4-9a46-fc8e3c1e82a1',
});
export const useIsFocused = () => true;
export const useNavigation = () => navigation;
export const useFocusEffect = (callback) => useEffect(callback, [callback]);
