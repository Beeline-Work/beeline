import type { SvgProps } from 'react-native-svg';

/**
 * What a drawn mark wears so it stays out of the accessibility tree and out of
 * the tab order — web implementation.
 *
 * react-native-svg hands whatever it does not consume straight to the element
 * it draws, and here that element is a DOM node. `accessibilityElementsHidden`
 * is a React Native prop the DOM does not know, so React logged an
 * unrecognized-prop error for every mark the app painted; `aria-hidden` is the
 * attribute that actually hides it.
 */
export const DECORATIVE_GLYPH_PROPS: SvgProps = {
  'aria-hidden': true,
  focusable: false,
};
