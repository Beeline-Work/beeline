// Execute the shipped polkit rule with the same action/subject API, without root.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
let rule;
const Result = {YES: 'yes', NO: 'no', NOT_HANDLED: undefined};
vm.runInNewContext(fs.readFileSync(__dirname + '/00-beeline-ci.rules', 'utf8'), {
  polkit: {Result, addRule: fn => { rule = fn; }},
});
function verdict(unit, verb, id = 'org.freedesktop.systemd1.manage-units', user = 'lunchbox') {
  return rule({id, lookup: name => ({unit, verb})[name]}, {user});
}
const units = ['beeline-ci-registration.socket', 'beeline-ci-registration.service'];
for (let i = 1; i <= 4; i++) units.push(`beeline-ci-shard-${i}.service`, `beeline-ci-shard-${i}-docker.service`);
for (const unit of units) {
  for (const verb of ['start', 'stop', 'restart']) assert.equal(verdict(unit, verb), Result.YES);
  for (const verb of ['set-property', 'kill', 'reload', 'enable']) assert.equal(verdict(unit, verb), Result.NO);
  assert.notEqual(verdict(unit, 'restart', undefined, 'beeline-ci-shard-1'), Result.YES);
}
for (const unit of ['ssh.service', 'beeline-prod-host.service', 'beeline-ci-shard-5.service', 'beeline-ci-evil.service', '../ssh.service', 'beeline-ci-shard-1.service --system']) {
  assert.equal(verdict(unit, 'start'), Result.NO);
}
assert.equal(verdict('beeline-ci-sync.service', 'start'), Result.YES);
assert.equal(verdict('beeline-ci-sync.service', 'restart'), Result.NO);
assert.notEqual(verdict('/bin/sh', 'start', 'org.freedesktop.policykit.exec'), Result.YES);
assert.equal(verdict('', '', 'org.freedesktop.systemd1.manage-unit-files'), Result.NO);
assert.equal(verdict('', '', 'org.freedesktop.systemd1.set-environment'), Result.NO);
console.log('CI-ACCESS-1 PASS: exact runner restart allowed; unrelated/new units, unit edits, environment changes and arbitrary root execution receive no grant');
