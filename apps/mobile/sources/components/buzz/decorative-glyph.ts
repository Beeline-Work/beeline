import type { SvgProps } from 'react-native-svg';

/**
 * What a drawn mark wears so it stays out of the accessibility tree and out of
 * the tab order — native implementation. The control around the glyph already
 * carries the label.
 *
 * react-native-svg hands whatever it does not consume straight to the element
 * it draws, so the prop has to be one that element understands: a native view
 * reads `accessibilityElementsHidden`, and the web sibling of this file sends
 * `aria-hidden` because the DOM does not.
 */
export const DECORATIVE_GLYPH_PROPS: SvgProps = {
  accessibilityElementsHidden: true,
  focusable: false,
};
