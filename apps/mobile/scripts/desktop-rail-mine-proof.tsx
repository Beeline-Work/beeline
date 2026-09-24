import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { readChatListView } from '@beeline/api-contract/phone';
import { DesktopRoomCorners } from '../sources/components/buzz/DesktopRoomCorners';

/**
 * The desktop rail under two Rooms, fed a chat-list response exactly as the
 * server sends it and read through the client's own guard. Alpha has four
 * corners that are the viewer's and two that are someone else's; Beta has
 * only someone else's.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = uuid(900);
const room = (id: number, name: string) => ({ id: uuid(id), name, workspaceId });
const response = {
  workspace: { id: workspaceId, name: 'Proof', role: 'member', updatedAt: 1_790_000_000 },
  viewer: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Me' },
  truncated: false,
  watchFilters: [],
  chats: [
    {
      room: room(100, 'alpha'),
      unread: false,
      cornerCount: 6,
      waitingCornerCount: 2,
      openCorners: [
        { id: uuid(1), name: 'mine-working', state: 'working', mine: true },
        { id: uuid(2), name: 'theirs-waiting', state: 'waiting' },
        { id: uuid(3), name: 'mine-review', state: 'review', mine: true },
        { id: uuid(4), name: 'awaits-me-waiting', state: 'waiting', mine: true },
        { id: uuid(5), name: 'theirs-working', state: 'working' },
        { id: uuid(6), name: 'mine-working-2', state: 'working', mine: true },
      ],
    },
    {
      room: room(200, 'beta'),
      unread: false,
      cornerCount: 1,
      waitingCornerCount: 1,
      openCorners: [{ id: uuid(7), name: 'theirs-only', state: 'waiting' }],
    },
  ],
};

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

async function run() {
  const view = readChatListView(response);
  if (!view) throw new Error('chat list did not parse');
  createRoot(document.getElementById('root')!).render(
    <div style={{ width: 360 }}>
      {view.chats.map((item) => (
        <div key={item.room.id} data-testid={`room-${item.room.name}`}>
          <div>{item.room.name}</div>
          <DesktopRoomCorners
            item={item}
            onOpen={() => undefined}
            renderDrag={(_, children) => children}
          />
        </div>
      ))}
    </div>,
  );
  for (let i = 0; i < 4; i += 1) await pause();

  const lines: string[] = [];
  let pass = true;
  for (const name of ['alpha', 'beta']) {
    const host = document.querySelector<HTMLElement>(`[data-testid="room-${name}"]`)!;
    const rows = Array.from(
      host.querySelectorAll<HTMLElement>('[data-testid^="desktop-corner-"]'),
    ).filter((node) => !node.dataset.testid!.startsWith('desktop-corner-glyph-'));
    const listed = rows.map((row) => {
      const texts = Array.from(row.querySelectorAll('div, span'))
        .filter((node) => node.children.length === 0 && node.textContent)
        .map((node) => node as HTMLElement);
      const label = texts[texts.length - 1]!;
      const glyph = row.querySelector('[data-testid^="desktop-corner-glyph-"]') !== null;
      return `${glyph ? 'glyph ' : ''}${texts[0]!.textContent} ${label.textContent}(${getComputedStyle(label).color})`;
    });
    const rest = host.textContent!.replace(name, '');
    const extras = /\d|corner|Mine|others|more/.test(
      rest.replace(/mine-|awaits-me-|theirs-/g, '').replace(/-2/g, ''),
    );
    lines.push(
      `${name}: [${listed.join(', ')}] toggles=${host.querySelectorAll('[aria-expanded], [role="switch"]').length} countsOrExtras=${extras}`,
    );
    const names = rows.map((row) => row.getAttribute('aria-label'));
    if (name === 'alpha') {
      pass &&=
        JSON.stringify(names) ===
        JSON.stringify([
          'Open corner awaits-me-waiting, waiting',
          'Open corner mine-working, working',
          'Open corner mine-review, review',
          'Open corner mine-working-2, working',
        ]);
    } else {
      pass &&= names.length === 0;
    }
    pass &&= !extras && host.querySelectorAll('[aria-expanded], [role="switch"]').length === 0;
  }
  report(`${pass ? 'PASS' : 'FAIL'}\n${lines.join('\n')}`);
}

run().catch((error) => report(`FAIL ${String(error)}`));
