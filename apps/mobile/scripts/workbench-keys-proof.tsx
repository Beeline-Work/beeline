import React from 'react';
// @ts-expect-error This isolated proof harness uses the installed react-dom;
// the mobile package intentionally carries no production @types/react-dom.
import { createRoot } from 'react-dom/client';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SettingsRow } from '../sources/components/buzz/SettingsRow';
import { ServiceMark } from '../sources/components/buzz/ServiceMark';
import {
  connectionCompany,
  connectionDomainsLine,
  connectionInstrument,
  connectionTitle,
  type WorkbenchConnection,
} from '../sources/buzz/workbench';

// The deduped shape of the real Trusty Squire vault metadata (read from
// `GET https://trusty-squire-api.fly.dev/v1/vault/credentials`): resend has
// several entries, Sentry two, ipinfo one. Each carries the server-derived
// `faviconDomain` the Workbench DTO now projects.
const CONNECTIONS: WorkbenchConnection[] = [
  {
    ref: 'resend-squire-corpus',
    name: 'default',
    service: 'resend',
    hosts: ['api.resend.com'],
    faviconDomain: 'resend.com',
    state: 'active',
    ownerId: 'proof',
  },
  {
    ref: 'resend-firstmate-rc34',
    name: 'firstmate-rc34',
    service: 'resend',
    hosts: ['resend.com', 'api.resend.com'],
    faviconDomain: 'resend.com',
    state: 'active',
    ownerId: 'proof',
  },
  {
    ref: 'sentry-test-atlas-dsn',
    name: 'default',
    service: 'Sentry',
    hosts: ['sentry.io'],
    faviconDomain: 'sentry.io',
    state: 'active',
    ownerId: 'proof',
  },
  {
    ref: 'ipinfo-default',
    name: 'default',
    service: 'ipinfo',
    hosts: ['ipinfo.io'],
    faviconDomain: 'ipinfo.io',
    state: 'active',
    ownerId: 'proof',
  },
];

function Keys() {
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionLabel}>KEYS</Text>
        {CONNECTIONS.map((connection) => {
          const instrument = connectionInstrument(connection.state);
          const domains = connectionDomainsLine(connection);
          return (
            <SettingsRow
              key={connection.ref}
              chevron="right"
              description={domains || undefined}
              leading={
                <ServiceMark
                  company={connectionCompany(connection)}
                  domain={connection.faviconDomain}
                  testID={`workbench-connection-${connection.ref}-mark`}
                />
              }
              statusGlyph={instrument.glyph}
              testID={`workbench-connection-${connection.ref}`}
              title={connectionTitle(connection, CONNECTIONS)}
              value={instrument.value}
              valueTone={instrument.valueTone}
            />
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    screen: { flex: 1, backgroundColor: hull.bgTerminal },
    content: { padding: hull.space.md, paddingTop: hull.layout.screenTop },
    sectionLabel: { ...hull.type.sectionHead, color: hull.textMuted, marginBottom: hull.space.sm },
  };
});

createRoot(document.getElementById('root')!).render(<Keys />);
