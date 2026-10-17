import React, { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import Svg, { Circle, Ellipse, Path } from 'react-native-svg';
import type { CompanyLogo } from '@beeline/api-contract/workbench';
import { beelineThemes } from '@/buzz/groknight';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import { Typography } from '@/constants/Typography';
import { appBoardColors } from '@/buzz/app-board-style';
import linearMark from '../../../assets/app-logos/linear.png';
import gmailMark from '../../../assets/app-logos/gmail.png';
import calendarMark from '../../../assets/app-logos/calendar.png';
import driveMark from '../../../assets/app-logos/drive.png';
import docsMark from '../../../assets/app-logos/docs.png';
import sheetsMark from '../../../assets/app-logos/sheets.png';
import slackMark from '../../../assets/app-logos/slack.png';
import notionMark from '../../../assets/app-logos/notion.png';
import hubspotMark from '../../../assets/app-logos/hubspot.png';
import airtableMark from '../../../assets/app-logos/airtable.png';
import asanaMark from '../../../assets/app-logos/asana.png';
import jiraMark from '../../../assets/app-logos/jira.png';
import supabaseMark from '../../../assets/app-logos/supabase.png';
import neonMark from '../../../assets/app-logos/neon.png';
import youtubeMark from '../../../assets/app-logos/youtube.png';
import runwayMark from '../../../assets/app-logos/runway.png';

const BUNDLED_MARKS: Record<string, number> = {
  linear: linearMark,
  gmail: gmailMark,
  'google calendar': calendarMark,
  'google drive': driveMark,
  'google docs': docsMark,
  'google sheets': sheetsMark,
  slack: slackMark,
  notion: notionMark,
  hubspot: hubspotMark,
  airtable: airtableMark,
  asana: asanaMark,
  jira: jiraMark,
  supabase: supabaseMark,
  neon: neonMark,
  youtube: youtubeMark,
  runway: runwayMark,
};

/** Public favicon lookup; requests go to Google rather than the credential's service. */
export function serviceFaviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

/** A consistent tile for apps, with the official public favicon when available. */
export function AppMark({
  name,
  mark,
  domain,
  logo,
  size = 36,
  white = false,
  testID,
}: {
  name: string;
  /** Authoritative server logo; disables every legacy name/domain lookup. */
  mark?: CompanyLogo;
  domain?: string;
  logo?: string;
  size?: number;
  white?: boolean;
  testID?: string;
}) {
  const [failedUris, setFailedUris] = useState<string[]>([]);
  const imageSize = Math.round(size * 0.56);
  const bundled = mark ? undefined : BUNDLED_MARKS[name.toLowerCase()];
  const uri = mark ? (mark.kind === 'image' ? mark.uri : undefined) : bundled
    ? undefined
    : logo && !failedUris.includes(logo)
      ? logo
      : domain
        ? serviceFaviconUrl(domain)
        : undefined;
  const showImage = uri && !failedUris.includes(uri);
  return (
    <View
      testID={testID}
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.22),
          ...(showImage && mark?.kind === 'image' && mark.plate === 'dark' ? styles.darkPlate : {}),
          ...(white || (showImage && mark?.kind === 'image' && mark.plate === 'light') ? { backgroundColor: '#FFFFFF' } : {}),
        },
      ]}
    >
      {!showImage && !bundled ? (
        domain || (mark && mark.kind !== 'monogram') ? (
          <Svg width={imageSize} height={imageSize} viewBox="0 0 24 24" fill="none" stroke={styles.fallback.color} strokeWidth={1.4} {...DECORATIVE_GLYPH_PROPS}>
            <Circle cx={12} cy={12} r={9} /><Ellipse cx={12} cy={12} rx={4} ry={9} /><Path d="M3 12h18M5 7h14M5 17h14" />
          </Svg>
        ) : <Text style={styles.fallback}>{name.slice(0, 1).toUpperCase()}</Text>
      ) : null}
      {bundled ? (
        <Image
          accessibilityIgnoresInvertColors
          source={bundled}
          style={{ width: imageSize, height: imageSize }}
        />
      ) : null}
      {showImage ? (
        <Image
          testID={testID ? `${testID}-icon` : undefined}
          accessibilityIgnoresInvertColors
          source={{ uri }}
          onError={() => setFailedUris((current) => [...current, uri])}
          style={{ width: imageSize, height: imageSize }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const board = appBoardColors(theme.buzz);
  return {
    darkPlate: { backgroundColor: beelineThemes.obsidian.appTile },
    tile: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: board.tile,
      overflow: 'hidden',
    },
    fallback: { ...Typography.default('semiBold'), fontSize: 16, color: board.ink },
  };
});
