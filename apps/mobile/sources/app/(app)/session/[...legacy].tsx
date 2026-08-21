import { Redirect } from 'expo-router';

/** Old Happy session links now resolve to Beeline's Room list. */
export default function LegacySessionRedirect() {
    return <Redirect href="/buzz/channels" />;
}
