import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import WorkbenchScreen from '../sources/app/(app)/beeline/settings/workbench';
import { AppStatusIndicator } from '../sources/components/buzz/AppStatusIndicator';
import { setWorkbenchSource } from '../sources/buzz/workbench-source';
import { MockWorkbenchSource } from '../sources/buzz/workbench-source.mock';

/**
 * Workbench app status proof, in two pages:
 *
 *   - `list` (default): the real Workbench with one connected, one connecting
 *     and one failed app;
 *   - `detail`: the app-detail status, which shares the mark but carries its
 *     own body copy.
 *
 * Each page reports the mark it drew and the label colour it computed.
 * `AppStatusIndicator.browser.test.ts` runs it in Obsidian and Bone at phone
 * and desktop widths, asserting the facts and capturing a screenshot per run.
 */
const page = new URLSearchParams(location.search).get('page') ?? 'list';
const report = (text: string) => {
  const element = document.getElementById('result');
  if (element) element.textContent = text;
};
const pause = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
const present = (id: string) => Boolean(document.querySelector(`[data-testid="${id}"]`));
const colorAt = (id: string) => {
  const element = document.querySelector(`[data-testid="${id}"]`);
  return element ? getComputedStyle(element).color : 'missing';
};
const fact = (name: string, value: boolean) => `${name}=${value ? 'yes' : 'no'}`;

function DetailProof() {
  const { theme } = useUnistyles();
  const textStyle = { ...theme.buzz.type.body, color: theme.buzz.appInk };
  return (
    <View style={{ padding: 24, gap: 12, minHeight: 844, backgroundColor: theme.buzz.appCanvas }}>
      <Text style={{ ...theme.buzz.type.sectionHead, color: theme.buzz.appQuiet }}>
        APP DETAIL STATUS
      </Text>
      <AppStatusIndicator status="connected" label="Connected" textStyle={textStyle} testID="proof-detail-connected" />
      <AppStatusIndicator status="connecting" label="Connecting" textStyle={textStyle} testID="proof-detail-connecting" />
      <AppStatusIndicator status="error" label="Connection failed" textStyle={textStyle} testID="proof-detail-error" />
    </View>
  );
}

function source(): MockWorkbenchSource {
  const mock = new MockWorkbenchSource();
  mock.setApps([
    { id: 'app-gmail', key: 'gmail', name: 'Gmail', transport: 'composio', status: 'connected', useCount: 1 },
    { id: 'app-slack', key: 'slack', name: 'Slack', transport: 'composio', status: 'connecting', useCount: 0 },
    {
      id: 'app-runway',
      key: 'runway',
      name: 'Runway',
      transport: 'composio',
      status: 'error',
      errorMessage: 'App provider request failed (403)',
      useCount: 0,
    },
  ]);
  return mock;
}

async function read() {
  setWorkbenchSource(source());
  const root = document.getElementById('root')!;
  if (page === 'detail') {
    createRoot(root).render(<DetailProof />);
    await pause();
    await pause();
    const check = present('proof-detail-connected-check');
    const spinner = present('proof-detail-connecting-spinner');
    const failed = present('proof-detail-error-failed');
    report(
      `${check && spinner && failed ? 'PASS' : 'FAIL'} connectedLabel=${colorAt('proof-detail-connected-label')} ` +
        `connectingLabel=${colorAt('proof-detail-connecting-label')} errorLabel=${colorAt('proof-detail-error-label')} ` +
        `${fact('detailCheck', check)} ${fact('detailSpinner', spinner)} ${fact('detailFailed', failed)}`,
    );
    return;
  }
  createRoot(root).render(<WorkbenchScreen />);
  await pause();
  await pause();
  const check = present('workbench-app-gmail-status-check');
  const spinner = present('workbench-app-slack-status-spinner');
  const glow = present('workbench-app-slack-status-spinner-glow');
  const failedMark = present('workbench-app-runway-status-failed');
  report(
    `${check && spinner && glow && failedMark ? 'PASS' : 'FAIL'} ` +
      `connectedLabel=${colorAt('workbench-app-gmail-status-label')} ` +
      `connectingLabel=${colorAt('workbench-app-slack-status-label')} ` +
      `errorLabel=${colorAt('workbench-app-runway-status-label')} ` +
      `${fact('check', check)} ${fact('spinner', spinner)} ${fact('glow', glow)} ${fact('failedMark', failedMark)}`,
  );
}

void read();