import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProductionAppConfig, assertProductionBundleDump, PRODUCTION_MOBILE_ORIGIN } from './assert-mobile-release-origin.mjs';

const config = origin => ({ extra: { app: { buzzyMonolithUrl: origin } } });
const dump = (origin, extra = '') => `s7557[ASCII, 317195..317215]: ${origin}
i45834[ASCII, 1187732..1187747] #0934F483: buzzyMonolithUrl
Function<loadAppConfig>(1 params, 17 registers, 0 symbols):
[@ 135] LoadConstString 2<Reg8>, 7557<UInt16>
${extra}[@ 139] PutById 1<Reg8>, 2<Reg8>, 1<UInt8>, 45834<UInt16>
[@ 149] Ret 1<Reg8>
Function<other>(1 params):
`;

test('native config alone cannot admit the contaminated Play build', () => {
  assert.doesNotThrow(() => assertProductionAppConfig(config(PRODUCTION_MOBILE_ORIGIN)));
  assert.throws(() => assertProductionBundleDump(dump('http://10.0.2.2:22881')), /embedded JS overrides.*10\.0\.2\.2:22881/);
});
test('both production configs pass; unexpected native origins and missing values fail', () => {
  assert.doesNotThrow(() => assertProductionBundleDump(dump(PRODUCTION_MOBILE_ORIGIN)));
  for (const origin of ['http://localhost:8081', 'https://server.usebeeline.app.evil', `${PRODUCTION_MOBILE_ORIGIN}/`, undefined]) {
    assert.throws(() => assertProductionAppConfig(config(origin)), /unexpected monolith origin/);
  }
});
test('a bundle without an env override uses the verified native config', () => {
  assert.doesNotThrow(() => assertProductionBundleDump('Function<loadAppConfig>(1 params):\n[@ 0] Ret 0<Reg8>\nFunction<next>(1 params):\n'));
});
test('unrecognized functions and unproven overwritten register values fail closed', () => {
  assert.throws(() => assertProductionBundleDump('Function<somethingElse>(1 params):\n'), /expected one loadAppConfig/);
  assert.throws(() => assertProductionBundleDump(dump(PRODUCTION_MOBILE_ORIGIN, '[@ 137] Call1 2<Reg8>, 3<Reg8>, 4<Reg8>\n')), /unverified value/);
});
