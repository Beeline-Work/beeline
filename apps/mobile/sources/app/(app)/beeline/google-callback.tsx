import React, { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import { pendingGoogleLinkIdentity } from '@/auth/google-auth-session';

export default function GoogleCallbackFallback() {
  const [linking, setLinking] = useState<boolean | null>(null);
  useEffect(() => { void pendingGoogleLinkIdentity().then(id => setLinking(Boolean(id))); }, []);
  return linking === null ? null : <Redirect href={linking ? '/beeline/settings/identity' : '/beeline/onboarding'} />;
}
