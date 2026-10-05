import { Redirect } from 'expo-router';

/**
 * Settings is one list and it lives at `/beeline/settings`, so this route owns
 * no screen of its own: it sends the `/settings` path to that one account hub.
 */
export default function SettingsIndex() {
  return <Redirect href="/beeline/settings" />;
}
