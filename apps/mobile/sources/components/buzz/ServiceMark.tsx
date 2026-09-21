import React, { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { serviceMonogram } from '@/buzz/workbench';

/** The leading plate's side, and the width of the column it sits in. */
const SERVICE_MARK_SIZE = 28;
/** The favicon's side inside the plate, and its optical corner radius. */
const SERVICE_ICON_SIZE = 17;
const SERVICE_ICON_RADIUS = 3;

/**
 * The one favicon URL a row ever fetches — Google's favicon service, the same
 * one Trusty Squire's web vault points at
 * (`apps/web/app/vault/page.tsx` `ServiceIcon`).
 */
export function serviceFaviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

/**
 * ServiceMark — the leading mark on a key row: the company that key is for.
 *
 * A key belongs to whatever service the vault signed up for, so there is no
 * fixed catalog of art to draw from the way the tool connectors have one. The
 * mark is the service's real icon, fetched the way Trusty Squire fetches it:
 * the SERVER derives the brand domain from the credential's first allowed
 * host (`faviconDomain()` in Squire's `apps/api/src/routes/vault.ts`,
 * mirrored by `faviconDomain` in `@beeline/api-contract/workbench`), and this
 * plate asks Google's favicon service for that domain.
 *
 * The earlier objection here was real and is still the reason this is
 * worded carefully: a phone must not tell Resend or Sentry which of its
 * customers opened a screen. Squire's answer is that the request never
 * reaches the service — it goes to `www.google.com/s2/favicons`, which
 * already serves favicons for every domain, so the service learns nothing
 * about who is looking. Only Google sees the domain, and it sees it for a
 * public favicon lookup it would serve anyone.
 *
 * The lettermark stays painted BEHIND the image and shows through whenever
 * there is no domain, there is no network, or the image 404s — every row
 * renders correctly without an icon.
 */
export function ServiceMark({
  company,
  domain,
  testID,
}: {
  company: string;
  domain?: string;
  testID?: string;
}) {
  const [iconFailed, setIconFailed] = useState(false);
  const showIcon = Boolean(domain) && !iconFailed;
  return (
    <View style={styles.plate} testID={testID}>
      <Text style={styles.monogram}>{serviceMonogram(company)}</Text>
      {showIcon && (
        <Image
          accessibilityIgnoresInvertColors
          onError={() => setIconFailed(true)}
          source={{ uri: serviceFaviconUrl(domain as string) }}
          style={styles.icon}
          testID={testID ? `${testID}-icon` : undefined}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    plate: {
      width: SERVICE_MARK_SIZE,
      height: SERVICE_MARK_SIZE,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: hull.radius,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      backgroundColor: hull.bgRaised,
      overflow: 'hidden',
    },
    monogram: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textSecondary,
      position: 'absolute',
    },
    icon: {
      width: SERVICE_ICON_SIZE,
      height: SERVICE_ICON_SIZE,
      borderRadius: SERVICE_ICON_RADIUS,
    },
  };
});
