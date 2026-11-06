const fs = require('fs'),
  assert = require('node:assert/strict');
(async () => {
  const tabs = await (await fetch('http://127.0.0.1:9236/json')).json();
  const ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const v = JSON.parse(e.data);
    if (v.id) {
      pending.get(v.id)?.(v);
      pending.delete(v.id);
    }
  };
  const cmd = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await cmd('Page.enable');
  const receipts = [];
  for (const width of [390, 1280])
    for (const theme of ['bone', 'obsidian']) {
      await cmd('Emulation.setDeviceMetricsOverride', {
        width,
        height: 500,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cmd('Page.navigate', { url: 'http://localhost:9186/?theme=' + theme });
      await new Promise((r) => setTimeout(r, 800));
      await cmd('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
      const result = await cmd('Runtime.evaluate', {
        expression: `JSON.stringify([...document.querySelectorAll('[data-testid^="notification-run-cell-"]')].filter(e=>e.dataset.testid.match(/^notification-run-cell-\\d$/)).map(row=>{const r=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}};const link=row.querySelector('[role="link"]'),copy=link.children[1].firstChild;return {row:r(row),copy:r(copy),icons:[...row.querySelectorAll('svg')].map(r),text:copy.textContent,overflow:document.documentElement.scrollWidth>innerWidth}}))`,
        returnByValue: true,
      });
      const rows = JSON.parse(result.result.result.value);
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.equal(row.row.height, 44);
        assert.equal(row.overflow, false);
        assert.equal(row.icons[0].y + row.icons[0].height / 2, row.row.y + 22);
        assert.equal(row.icons[1].y + row.icons[1].height / 2, row.row.y + 22);
        if (process.argv[2] !== 'before')
          assert.equal(row.copy.y + row.copy.height / 2, row.row.y + 22);
      }
      receipts.push({ width, theme, rows });
      const shot = await cmd('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(
        '.beeline-proof/title-alignment/' + process.argv[2] + '-' + width + '-' + theme + '.png',
        Buffer.from(shot.result.data, 'base64'),
      );
      await cmd('Runtime.evaluate', {
        expression: `document.querySelector('[role="link"]').click()`,
      });
      const dest = await cmd('Runtime.evaluate', {
        expression: `document.getElementById('destination').textContent`,
        returnByValue: true,
      });
      receipts.at(-1).destination = dest.result.result.value;
      assert.equal(dest.result.result.value, 'corner-glyph-alignment');
      await cmd('Runtime.evaluate', {
        expression: `document.querySelectorAll('[role="link"]')[1].click()`,
      });
      const second = await cmd('Runtime.evaluate', {
        expression: `document.getElementById('destination').textContent`,
        returnByValue: true,
      });
      assert.equal(second.result.result.value, 'mock-embedded-fonts');
      receipts.at(-1).secondDestination = second.result.result.value;
    }
  fs.writeFileSync(
    '.beeline-proof/title-alignment/' + process.argv[2] + '.json',
    JSON.stringify(receipts, null, 2),
  );
  console.log(JSON.stringify(receipts));
  ws.close();
})();
