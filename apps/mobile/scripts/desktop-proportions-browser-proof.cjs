// Exercises the exported app against deterministic API fixtures; no production writes.
const { chromium } = require('playwright-core');
const http = require('http'),
  fs = require('fs'),
  path = require('path');
const out = process.env.BEELINE_PROOF_WEB_DIR;
if (!out) throw new Error('Set BEELINE_PROOF_WEB_DIR to an Expo web export');
const output =
  process.env.BEELINE_PROOF_OUTPUT || path.resolve('evidence/desktop-proportions/web-after');
const before = process.env.BEELINE_PROOF_BEFORE === '1';
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  let p = path.join(out, decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(out, 'index.html');
  const types = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
  };
  res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
const viewer = {
  pubkey: 'a'.repeat(64),
  kind: 'human',
  name: 'Desktop reviewer',
  handle: 'reviewer',
};
const agent = { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Ruby', handle: 'ruby' };
const ws = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Beeline',
  role: 'owner',
  updatedAt: 1,
};
const room = {
  id: '22222222-2222-4222-8222-222222222222',
  workspaceId: ws.id,
  name: 'Desktop layout',
  archived: false,
  createdAt: 1,
  updatedAt: 1,
};
const corner = { ...room, id: '33333333-3333-4333-8333-333333333333', name: 'Desktop proportions' };
const brief = {
  revision: 1,
  authorHandle: 'ruby',
  spec: '# Desktop layout proportions\n\n## Reading together\nMessages and documents share the available space. The chat stays readable while a file or brief sits beside it.\n\n### Useful space\nA centred reading column keeps each line comfortable.\n\n- Read the brief beside the conversation\n- Close the pane to return to the room list',
  attachments: [],
};
const attachment = {
  id: 'doc',
  kind: 'artifact',
  name: 'desktop-notes.md',
  title: 'Desktop notes',
  mimeType: 'text/markdown',
  size: 420,
  url: 'https://server.usebeeline.app/v1/media/44444444-4444-4444-8444-444444444444',
};
const messages = [
  {
    id: 'c'.repeat(64),
    roomId: room.id,
    author: viewer,
    createdAt: 1,
    text: 'Let’s keep the conversation readable while we open the project brief beside it.',
    tags: [],
  },
  {
    id: 'd'.repeat(64),
    roomId: room.id,
    author: agent,
    createdAt: 2,
    text: 'The reading column gives messages a comfortable measure. Opening a file uses the space beside the conversation, and closing it brings the room list back.',
    tags: [],
    attachments: [attachment],
  },
];
function roomView(isCorner = false) {
  return {
    room: isCorner ? corner : room,
    messages: isCorner ? [] : messages,
    members: [
      { identity: viewer, role: 'owner' },
      { identity: agent, role: 'member' },
    ],
    viewer: { identity: viewer, role: 'owner', permissions: { send: true, manage: true } },
    latestAgentTurns: [],
    pendingAgentCommands: [],
    watchFilters: [],
    ...(isCorner ? { parent: room, cornerBrief: brief } : {}),
  };
}
(async () => {
  await new Promise((r) => server.listen(8766, r));
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    colorScheme: process.env.BEELINE_PROOF_DARK === '1' ? 'dark' : 'light',
  });
  await page.addInitScript(
    ({ viewer, ws }) => {
      localStorage.setItem('buzzy.monolith.identity.v1', viewer.pubkey);
      localStorage.setItem('buzzy.monolith.refresh.v1', 'fixture-refresh');
      localStorage.setItem(
        'buzzy.monolith.access.v1',
        JSON.stringify({
          token: 'fixture',
          expiresAt: Date.now() + 86400000,
          identityId: viewer.pubkey,
        }),
      );
    },
    { viewer, ws },
  );
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://localhost:8766' && !url.pathname.startsWith('/document'))
      return route.continue();
    if (url.pathname.includes('/v1/media/'))
      return route.fulfill({ contentType: 'text/markdown', body: brief.spec });
    const p = url.pathname;
    let body = {};
    if (p.endsWith('/operations/readIdentitySettings'))
      body = {
        identity: {
          personId: viewer.pubkey,
          name: viewer.name,
          handle: viewer.handle,
          pushLevel: 'attention',
          providers: [],
        },
        workspaces: { viewer, workspaces: [ws], watchFilters: [] },
      };
    else if (p === '/v1/phone/workspaces') body = { viewer, workspaces: [ws], watchFilters: [] };
    else if (p.endsWith('/chats'))
      body = {
        viewer,
        workspace: ws,
        chats: [{ room, cornerCount: 1, latestMessage: messages[1] }],
        watchFilters: [],
      };
    else if (p.includes('/corners'))
      body = {
        room,
        viewer: { identity: viewer, role: 'owner', permissions: { send: true, manage: true } },
        corners: [
          {
            corner,
            state: 'working',
            mine: true,
            briefRevision: 1,
            lifecycle: { lifecycle: 'open', checks: 'unknown' },
          },
        ],
        watchFilters: [],
      };
    else if (p.includes('/history'))
      body = { roomId: room.id, messages: [], hasMore: false, watchFilters: [] };
    else if (p.includes('/phone/rooms/')) body = roomView(p.includes(corner.id));
    else if (p.endsWith('/' + ws.id))
      body = {
        workspace: ws,
        viewer: { identity: viewer, role: 'owner' },
        members: [],
        rooms: [room],
        watchFilters: [],
      };
    else if (p.includes('/profile') || p.endsWith('/me')) body = { identity: viewer, ...viewer };
    else
      body = {
        viewer,
        identity: viewer,
        workspaces: [ws],
        workspace: ws,
        items: [],
        members: [],
        runs: [],
        watchFilters: [],
      };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  const metrics = [];
  const capture = async (name, width) => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(output, name + '-' + width + '.png') });
  };
  const navigate = async (suffix) => {
    await page.goto('http://localhost:8766/beeline/' + suffix);
  };
  const settle = async () => {
    await page.waitForTimeout(700);
    await page.evaluate(() => document.fonts.ready);
  };
  for (const width of [1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await navigate('chat/' + room.id + '?communityId=' + ws.id);
    await page.getByTestId('artifact-preview-desktop-notes.md').waitFor();
    await settle();
    await capture('chat', width);
    const transcript = await page.getByTestId('chat-messages').evaluate((el) => ({
      viewport: el.getBoundingClientRect().width,
      column: el.firstElementChild.getBoundingClientRect().width,
    }));
    const chips = await page.getByTestId('room-filter-all').boundingBox();
    await page
      .getByRole('button', { name: 'Open Desktop notes full screen', exact: true })
      .first()
      .click();
    await page.getByTestId('desktop-artifact-markdown').waitFor();
    await settle();
    await capture('file', width);
    const panel = await page.getByTestId('desktop-inspector').boundingBox();
    if (!before) {
      if (Math.abs(panel.width - (width - (width >= 1360 ? 76 : 0)) * 0.55) > 2)
        throw Error('document proportion ' + panel.width);
      if (panel.x < 440) throw Error('chat below minimum ' + panel.x);
      await page.getByTestId('desktop-toggle-room-list').click();
      await settle();
      const shown = await page.getByTestId('desktop-inspector').boundingBox();
      const nav = await page.getByTestId('desktop-navigation-pane').boundingBox();
      if (shown.x - nav.width - (width >= 1360 ? 76 : 0) < 439)
        throw Error('chat below minimum with restored list');
    }
    await page.getByTestId('desktop-artifact-close').click();
    await settle();
    if (!(await page.getByTestId('desktop-navigation-pane').isVisible()))
      throw Error('room list did not return');
    await navigate('chat/' + corner.id + '?communityId=' + ws.id);
    await page.getByRole('link', { name: 'Read brief', exact: true }).first().waitFor();
    await settle();
    await page.getByRole('link', { name: 'Read brief', exact: true }).first().click();
    await settle();
    await capture('brief', width);
    if (!before) {
      await page.getByTestId('desktop-artifact-pane').waitFor();
      if (await page.getByTestId('desktop-artifact-open-browser').count())
        throw Error('brief has browser link');
      const font = await page.getByTestId('desktop-artifact-markdown').evaluate((el) => {
        const span = Array.from(el.querySelectorAll('span')).find(
          (e) => e.textContent === 'Desktop layout proportions',
        );
        return { font: getComputedStyle(span).fontFamily, size: getComputedStyle(span).fontSize };
      });
      if (!font.font.includes('SemiBold') || font.size !== '22px')
        throw Error('heading lost style ' + JSON.stringify(font));
      await page.getByTestId('desktop-artifact-close').click();
    }
    await navigate('settings');
    await page.getByText('Appearance', { exact: true }).first().waitFor();
    await settle();
    await capture('settings', width);
    await navigate('corners/' + room.id + '?communityId=' + ws.id);
    await page.getByTestId('room-corners-filter-all').waitFor();
    await settle();
    await capture('corners', width);
    if (!before) {
      await page.getByRole('link', { name: 'Read brief', exact: true }).first().click();
      await page.getByTestId('desktop-artifact-pane').waitFor();
      await settle();
      await capture('brief-from-list', width);
    }
    metrics.push({ width, transcript, mouseChipHeight: chips.height, panelWidth: panel.width });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate('chat/' + room.id + '?communityId=' + ws.id);
  await page.getByTestId('artifact-preview-desktop-notes.md').waitFor();
  await settle();
  await capture('phone', 390);
  if (!before) {
    await page.setViewportSize({ width: 1000, height: 900 });
    await navigate('chat/' + room.id + '?communityId=' + ws.id);
    await page.getByTestId('artifact-preview-desktop-notes.md').waitFor();
    await settle();
    await page
      .getByRole('button', { name: 'Open Desktop notes full screen', exact: true })
      .first()
      .click();
    await settle();
    if (await page.getByTestId('desktop-artifact-pane').count())
      throw Error('narrow window did not fall back');
    const touch = await browser.newContext({
      hasTouch: true,
      viewport: { width: 1280, height: 900 },
    });
    const touchPage = await touch.newPage();
    await touchPage.addInitScript(
      ({ viewer }) => {
        localStorage.setItem('buzzy.monolith.identity.v1', viewer.pubkey);
        localStorage.setItem('buzzy.monolith.refresh.v1', 'fixture-refresh');
        localStorage.setItem(
          'buzzy.monolith.access.v1',
          JSON.stringify({
            token: 'fixture',
            expiresAt: Date.now() + 86400000,
            identityId: viewer.pubkey,
          }),
        );
      },
      { viewer },
    );
    await touchPage.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://localhost:8766') return route.continue();
      const p = url.pathname;
      let body = { viewer, items: [], members: [], runs: [], watchFilters: [] };
      if (p.endsWith('/chats'))
        body = { viewer, workspace: ws, chats: [{ room, cornerCount: 1 }], watchFilters: [] };
      else if (p === '/v1/phone/workspaces') body = { viewer, workspaces: [ws], watchFilters: [] };
      else if (p.includes('/phone/rooms/')) body = roomView();
      else if (p.endsWith('/' + ws.id))
        body = {
          workspace: ws,
          viewer: { identity: viewer, role: 'owner' },
          members: [],
          rooms: [room],
          watchFilters: [],
        };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await touchPage.goto('http://localhost:8766/beeline/chat/' + room.id + '?communityId=' + ws.id);
    await touchPage.getByTestId('room-filter-all').waitFor();
    const touchChip = await touchPage.getByTestId('room-filter-all').boundingBox();
    if (touchChip.height !== 44) throw Error('touch chip is ' + touchChip.height);
    metrics.push({ touchChipHeight: touchChip.height });
    await touch.close();
  }
  fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(metrics, null, 2));
  console.log('PASS desktop-proportions: ' + JSON.stringify(metrics));
  await browser.close();
  server.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
