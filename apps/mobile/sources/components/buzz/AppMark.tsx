import React, { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { serviceFaviconUrl } from './ServiceMark';
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

/** A consistent tile for apps, with the official public favicon when available. */
export function AppMark({ name, domain, logo, size = 36, white = false }: { name: string; domain?: string; logo?: string; size?: number; white?: boolean }) {
  const [failedUris, setFailedUris] = useState<string[]>([]);
  const imageSize = Math.round(size * 0.56);
  const bundled = BUNDLED_MARKS[name.toLowerCase()];
  const uri = bundled ? undefined : logo && !failedUris.includes(logo) ? logo : domain ? serviceFaviconUrl(domain) : undefined;
  const showImage = uri && !failedUris.includes(uri);
  return <View style={[styles.tile, { width: size, height: size, borderRadius: Math.round(size * .22), ...(white ? { backgroundColor: '#FFFFFF' } : {}) }]}>
    {!showImage && !bundled ? <Text style={styles.fallback}>{name.slice(0, 1).toUpperCase()}</Text> : null}
    {bundled ? <Image accessibilityIgnoresInvertColors source={bundled} style={{ width: imageSize, height: imageSize }} /> : null}
    {showImage ? <Image accessibilityIgnoresInvertColors source={{ uri }} onError={() => setFailedUris(current => [...current, uri])} style={{ width: imageSize, height: imageSize }} /> : null}
  </View>;
}

const styles = StyleSheet.create((theme) => {
  const board = appBoardColors(theme.buzz);
  return {
    tile: { alignItems: 'center', justifyContent: 'center', backgroundColor: board.tile, overflow: 'hidden' },
    fallback: { ...Typography.default('semiBold'), fontSize: 16, color: board.ink },
  };
});
