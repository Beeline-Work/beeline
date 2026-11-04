import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

/** Retained navigation screens release network observers on actual blur.
 * Component mount alone does not make a surface focused.
 */
export function useSurfaceFocus(): boolean {
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => { setFocused(false); };
  }, []));
  return focused;
}
