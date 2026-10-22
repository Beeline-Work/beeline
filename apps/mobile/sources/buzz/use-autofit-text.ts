import { useRef } from 'react';
import type { Text } from 'react-native';

/** Native Text owns fitting through adjustsFontSizeToFit. */
export function useAutoFitText(_text: string) {
  return useRef<Text>(null);
}
