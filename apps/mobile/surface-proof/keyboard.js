export { KeyboardAvoidingView } from 'react-native';
export const useKeyboardState = (selector) => selector({ height: 0, isVisible: false });
export const useReanimatedKeyboardAnimation = () => ({
  height: { value: 0 },
  progress: { value: 0 },
});
