import { useLayoutEffect, useRef } from 'react';
import type { Text } from 'react-native';

/** React Native Web omits adjustsFontSizeToFit; measure the rendered font. */
export function useAutoFitText(text: string) {
  const ref = useRef<Text>(null);
  useLayoutEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (!node) return;
    let active = true;
    let previousWidth = -1;
    const fit = () => {
      if (!active) return;
      node.style.removeProperty('font-size');
      const size = Number.parseFloat(getComputedStyle(node).fontSize);
      if (node.clientWidth > 0 && node.scrollWidth > node.clientWidth) {
        node.style.setProperty('font-size', `${size * node.clientWidth / node.scrollWidth}px`);
      }
      previousWidth = node.clientWidth;
    };
    fit();
    void document.fonts.ready.then(fit);
    const observer = new ResizeObserver(() => {
      if (node.clientWidth !== previousWidth) fit();
    });
    observer.observe(node);
    return () => { active = false; observer.disconnect(); node.style.removeProperty('font-size'); };
  }, [text]);
  return ref;
}
