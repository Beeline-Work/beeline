import { View } from 'react-native';
export default { View };
export const Easing = { bezier: () => {}, out: (x) => x, poly: () => {} };
export const ReduceMotion = { System: 'system' };
export const runOnJS = (fn) => fn;
export const useAnimatedStyle = (fn) => fn();
export const useReducedMotion = () => false;
export const useSharedValue = (value) => ({ value });
export const withTiming = (value) => value;
