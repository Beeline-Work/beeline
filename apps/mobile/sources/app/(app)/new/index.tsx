import { Redirect } from 'expo-router';

/** Retained only so old bookmarks do not land on a missing legacy session route. */
export default function LegacyNewSessionRedirect() {
    return <Redirect href="/buzz/channels" />;
}
