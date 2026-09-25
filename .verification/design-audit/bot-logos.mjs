import { openTab, signIn, sleep, session, WEB } from './drive.mjs';

const cdp = await openTab();
await cdp.viewport(430, 932, true);
await sleep(4000);
await signIn(cdp);
await sleep(5000);
for (const [name, id] of process.argv.includes('--list-only')
  ? []
  : Object.entries(session.botRooms)) {
  await cdp.send('Page.navigate', { url: `${WEB}/beeline/chat/${id}` });
  await sleep(5500);
  const info = await cdp.eval(
    `JSON.stringify({path:location.pathname,text:document.body.innerText.slice(0,700),header:!!document.querySelector('[data-testid="direct-message-header-identity"]'),receipt:!!document.querySelector('[data-testid="connector-receipt-card"]'),logo:!!document.querySelector('[data-testid="connector-receipt-logo"]')})`,
  );
  console.log(name, info, cdp.errors.slice(-3));
  const observed = JSON.parse(info);
  if (
    observed.path !== `/beeline/chat/${id}` ||
    !observed.header ||
    (name !== 'system' && (!observed.receipt || !observed.logo))
  ) {
    throw new Error(`missing app surface for ${name}: ${info}`);
  }
  await cdp.shot(`apps/mobile/evidence/system-bot-logos/app-${name}.png`);
}
await cdp.send('Page.navigate', { url: `${WEB}/beeline/channels` });
await sleep(5500);
console.log(
  'channels',
  await cdp.eval('document.body.innerText.slice(0,1400)'),
  cdp.errors.slice(-3),
);
await cdp.shot('apps/mobile/evidence/system-bot-logos/app-messages-list.png');
await cdp.send('Input.dispatchMouseEvent', {
  type: 'mouseWheel',
  x: 390,
  y: 780,
  deltaY: 1100,
  deltaX: 0,
});
await sleep(1200);
await cdp.shot('apps/mobile/evidence/system-bot-logos/app-messages-list-lower.png');
await cdp.send('Page.navigate', { url: `${WEB}/beeline/settings/workbench` });
await sleep(5500);
console.log(
  'workbench',
  await cdp.eval('document.body.innerText.slice(0,1400)'),
  cdp.errors.slice(-3),
);
await cdp.shot('apps/mobile/evidence/system-bot-logos/app-workbench.png');
await cdp.eval(
  `([...document.querySelectorAll('div,button')].reverse().find((node) => node.innerText?.trim() === 'Google Workspace'))?.click()`,
);
await sleep(1000);
await cdp.shot('apps/mobile/evidence/system-bot-logos/app-workbench-google.png');
await cdp.close();
