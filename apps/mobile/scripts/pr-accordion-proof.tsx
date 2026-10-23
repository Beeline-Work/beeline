import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { NotificationLifecycleCard } from '../sources/components/buzz/PrLifecycleCard';
import { anchorCornerMarkers } from '../sources/buzz/corner-markers';
import { CornerOpenedMarker } from '../sources/components/buzz/CornerOpenedMarker';
import { foldPrLifecycleRuns, lifecycleCornerTitle } from '../sources/buzz/pr-lifecycle';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
import snapshot from './transcript-event-room-snapshot.json';
const root = createRoot(document.getElementById('root')!);
const assert = (ok: unknown, reason: string) => {
  if (!ok) throw Error(reason);
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
const get = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const rows = snapshot.runs.flatMap((run, index) => [
  ...(index
    ? [{ id: 'chat-boundary', text: 'Decision stays visible', timestamp: 1, isUser: false }]
    : []),
  ...run.map(
    (row) =>
      ({
        id: row.id,
        text: row.text,
        timestamp: Number(row.timestamp),
        isUser: false,
        ...(row.card_type === 'daemon-fact' ? { daemonFact: row.card } : { githubEvent: row.card }),
      }) as ChatDisplayMessage,
  ),
]);
const source = { id: 'asking-message', text: 'Please open a corner for this task', timestamp: 1, isUser: true };
const anchored = { ...rows.find(row => row.daemonFact?.type === 'corner-open')!, id: 'anchored-open',
  daemonFact: { ...rows.find(row => row.daemonFact?.type === 'corner-open')!.daemonFact!, sourceMessageId: source.id } };
const messages = foldPrLifecycleRuns(anchorCornerMarkers<ChatDisplayMessage>([...rows, source, anchored]));
let destination = '';
root.render(
  <>
    {messages.map((message) =>
      message.notificationLifecycleRun ? (
        <NotificationLifecycleCard
          key={message.id}
          message={message}
          onOpenCorner={(id) => {
            destination = id;
          }}
          onOpenUrl={(url) => {
            destination = url;
          }}
        />
      ) : message.daemonFact?.type === 'corner-open' ? (
        <CornerOpenedMarker
          key={message.id}
          title={lifecycleCornerTitle(message.daemonFact)}
          onOpen={() => {
            destination = message.daemonFact!.cornerId;
          }}
        />
      ) : (
        <div key={message.id} data-testid={message.id}>{message.text}
          {message.cornerMarkers?.map(marker => <CornerOpenedMarker key={marker.id}
            testID="anchored-marker" title={lifecycleCornerTitle(marker.daemonFact!)}
            onOpen={() => { destination = marker.daemonFact!.cornerId; }} />)}
        </div>
      ),
    )}
  </>,
);
async function main() {
  await pause();
  const first = snapshot.runs[0][0].id;
  const toggle = get(`notification-run-expand-${first}`);
  assert(toggle.textContent === '1 issue filed · 1 PR merged', 'mixed type summary');
  assert(
    Array.from(document.querySelectorAll('[data-testid^="notification-run-cell-"]')).filter(el => !get('asking-message').contains(el)).length === 0,
    'starts expanded',
  );
  toggle.click();
  await pause();
  assert(
    get(`notification-run-cell-${first}`) && get(`notification-run-cell-${snapshot.runs[0][1].id}`),
    'one line per event',
  );
  get(`notification-run-cell-url-${first}`).click();
  assert(
    destination === ('url' in snapshot.runs[0][0].card ? snapshot.runs[0][0].card.url : undefined),
    'issue destination',
  );
  const merge = snapshot.runs[0][1];
  get(`notification-run-cell-corner-${merge.id}`).click();
  assert(destination === merge.card.cornerId, 'corner destination');
  get(`notification-run-cell-url-${merge.id}`).click();
  assert(destination === merge.card.pullRequest?.url, 'PR destination');
  const second = snapshot.runs[1][0].id;
  get(`notification-run-expand-${second}`).click();
  await pause();
  assert(!document.querySelectorAll('[data-testid^="notification-run-cell-"]').length ||
    !Array.from(document.querySelectorAll('[data-testid^="notification-run-cell-"]')).some(el => !get('asking-message').contains(el) && el.textContent?.includes('Opened')), 'legacy opened row visible');
  assert(get('asking-message').contains(get('anchored-marker')), 'marker is not under asking message');
  get('anchored-marker').click();
  assert(destination === anchored.daemonFact.cornerId, 'anchored corner destination');
  get(`notification-run-expand-${second}`).click();
  await pause();
  assert(document.body.textContent?.includes('Decision stays visible'), 'agent decision folded');
  toggle.click();
  await pause();
  assert(
    Array.from(document.querySelectorAll('[data-testid^="notification-run-cell-"]')).filter(el => !get('asking-message').contains(el)).length === 0,
    'collapse',
  );
  assert(document.documentElement.scrollWidth <= innerWidth, 'horizontal overflow');
  document.getElementById('result')!.textContent =
    'PASS EVENT-ROWS-V2: real Room events, mixed summary, collapsed, expanded, links, R1 legacy opens hidden, anchored marker under asking message, decision boundary';
}
main().catch(
  (error) => (document.getElementById('result')!.textContent = `FAIL: ${error.message}`),
);
