import { test } from 'vitest';
import assert from 'node:assert/strict';
import { inspectSource } from './router-boundaries.mjs';

test('phone write backdoors fail in the current route tree, including aliased and destructured capabilities', () => {
  const file = 'apps/mobile/sources/app/(app)/beeline/backdoor.tsx';
  for (const source of [
    "socket.request('sendFromWallet', input)",
    "navigator.locks.request('key',{mode:'exclusive'},()=>socket.request('sendFromWallet',input))",
    "socket['request']('reactToMessage', input)",
    "import { sharedLiveConnection as live } from '@/sync/transport/live-connection'; const a=live(); const b=a; const send=b.request; send('sendFromWallet',input);",
    "import { sharedLiveConnection as live } from '@/sync/transport/live-connection'; const { request: send }=live(); send('sendFromWallet',input);",
    "const { requestCommand: send } = socket; send(op,args,id);",
    "export { MobileCommandOwner as Backdoor } from '@/buzz/command-owner';",
    "import { activateCommandOwner as install } from '@/buzz/command-owner';",
  ]) assert.ok(inspectSource(file, source).errors.length, source);
  assert.deepEqual(inspectSource('apps/mobile/sources/sync/transport/monolith-operation.ts',
    'sharedLiveConnection().request(name,input)').errors, []);
});

test('a second phone ingress or fresh-result mint cannot escape the declared server owners', () => {
  for (const source of [
    "import { createPhoneOperationDispatcher as backdoor } from './phone-operations.js';",
    "export { createPhoneOperationDispatcher } from './phone-operations.js';",
    "import { immediateCommandResult as forge } from './router-command-coverage.js';",
    "export * from './router-command-coverage.js';",
  ]) assert.ok(inspectSource('apps/server/src/backdoor.ts', source).errors.length, source);
});

test('a phone route cannot invoke or extract the domain executor around command admission', () => {
  for (const source of [
    "options.phone.execute('sendFromWallet', input, viewer)",
    "const p=options.phone; const alias=p; alias['execute'](name,input,viewer)",
    "const {execute: send}=options.phone; send(name,input,viewer)",
    "import { PhoneService as Service } from './phone-service.js'; const p=new Service(db); p.execute(name,input,viewer)",
    "const module=await import('./phone-operations.js');",
  ]) assert.ok(inspectSource('apps/server/src/route.ts', source).errors.length, source);
  assert.deepEqual(inspectSource('apps/server/src/phone-operations.ts', 'phone.execute(name,input,viewer)').errors, []);
});
