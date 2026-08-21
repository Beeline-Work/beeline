import { Redirect } from 'expo-router';

/** Retained for old settings bookmarks; Beeline settings owns this destination. */
export default function LegacySettingsRedirect() {
    return <Redirect href="/buzz/settings" />;
}
