import { expect, it } from 'vitest';
import { routes } from './routes.js';
import { observePhoneInput } from './phone-inputs.js';
import { phoneInputs } from './generated-phone-input-shapes.js';

it('projects all phone input codecs without changing their structural decisions', () => {
  expect(Object.keys(phoneInputs).map(name => `phone.${name}`).sort())
    .toEqual(Object.keys(routes).filter(name => name.startsWith('phone.')).sort());
  const samples = [null, undefined, {}, [], 'value', 12, { roomId: 'r' }, { workspaceId: 'w' },
    { roomId: 'r', text: 'Hello', messageId: 'a'.repeat(64) }, { roomId: 'r', memberIds: ['ada'] }];
  for (const name of Object.keys(phoneInputs) as (keyof typeof phoneInputs)[]) {
    const route = routes[`phone.${name}`];
    for (const input of samples) {
      let verdict: 'legacy-valid' | 'legacy-invalid' | 'wrong-transport' = 'legacy-invalid';
      if (route.transport !== 'main-socket') verdict = 'wrong-transport';
      else { try { route.params.parse(input); verdict = 'legacy-valid'; } catch { /* expected rejection */ } }
      expect(observePhoneInput(name, input)).toEqual({ route: route.id, verdict });
    }
  }
});

it('records no arbitrary unknown operation or input data', () => {
  for (const name of ['secret-operation', '__proto__', 'constructor', Symbol('secret'), null])
    expect(observePhoneInput(name, { secret: true })).toEqual({ route: 'undeclared', verdict: 'undeclared' });
});
