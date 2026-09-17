// Proof-only unistyles: resolves StyleSheet.create factory form against the
// real groknight theme, exactly like the committed web proof. The component
// code and style VALUES stay the shipped ones; only unistyles' native runtime
// (not present in Expo Go) is stood in for.
import { groknight } from '../sources/buzz/groknight';

export const StyleSheet = {
  create: (factory: unknown) =>
    typeof factory === 'function' ? (factory as (t: object) => object)({ buzz: groknight }) : factory,
};
export function useUnistyles() {
  return { theme: { buzz: groknight } };
}
