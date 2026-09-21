import { Redirect } from 'expo-router';

/**
 * `(app)/_layout.tsx` declares this screen, and `settings/language` sits under
 * it, but the route file itself went with the sidebar simplification in #1431 —
 * so expo-router warned about a named screen with no route at every boot.
 *
 * Settings is one list and it lives at `/beeline/settings`, so this route owns
 * no screen of its own: it sends the `/settings` path to that one account hub.
 */
export default function SettingsIndex() {
  return <Redirect href="/beeline/settings" />;
}
