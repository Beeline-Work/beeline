import { View, Text, ScrollView } from 'react-native';
const identity = (value) => value;
const entering = {
  duration: () => entering,
  easing: () => entering,
  reduceMotion: () => entering,
  withInitialValues: () => entering,
};
export const Easing = {
  bezier: () => identity,
  out: identity,
  inOut: identity,
  poly: () => identity,
  linear: identity,
  cubic: identity,
};
export const FadeInDown = entering;
export const FadeOut = entering;
export const ReduceMotion = { System: 'system' };
export const useReducedMotion = () => true;
export const useAnimatedStyle = (factory) => factory();
export const useAnimatedProps = (factory) => factory();
export const useSharedValue = (value) => ({ value });
export const useDerivedValue = (factory) => ({ value: factory() });
export const useFrameCallback = () => ({ setActive() {} });
export const withRepeat = identity;
export const withSequence = (...values) => values[0];
export const withTiming = identity;
export const withDelay = (_, value) => value;
export const cancelAnimation = () => {};
export const runOnJS = identity;
export const runOnUI = identity;
export const interpolate = identity;
export const interpolateColor = (progress, _, values) =>
  progress === 1 ? values[values.length - 1] : values[0];
export default { View, Text, ScrollView, createAnimatedComponent: identity };
