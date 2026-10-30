import { expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
vi.mock('node:child_process', () => ({spawnSync: vi.fn()}));
vi.mock('node:fs', () => ({openSync: vi.fn(), closeSync: vi.fn()}));
import { prepareKvmAccess } from './kvm-device-access.js';
const denied = () => { throw Object.assign(new Error('permission denied'), {code:'EACCES'}); };
const missing = () => { throw Object.assign(new Error('no such file'), {code:'ENOENT'}); };
it('only an approved KVM grant attempts a host ACL for the helper user', () => {
  let allowed = false;
  const acl = vi.fn((uid: number) => { expect(uid).toBe(1006); allowed = true; });
  const dependencies = {uid:()=>1006, probe:()=>{ if (!allowed) denied(); }, acl};
  expect(prepareKvmAccess([], dependencies).status).toBe('needs-grant');
  expect(prepareKvmAccess(['/dev/ttyUSB0'], dependencies).status).toBe('needs-grant');
  expect(acl).not.toHaveBeenCalled();
  expect(prepareKvmAccess(['/dev/kvm'], dependencies)).toEqual({status:'works'});
  expect(acl).toHaveBeenCalledTimes(1);
  expect(acl).toHaveBeenCalledWith(1006);
  expect(allowed).toBe(true);
});
it('Reproduction R1: without a grant, a denied open tells the agent to request a /dev/kvm device grant', () => {
  const acl = vi.fn();
  const access = prepareKvmAccess([], {uid:()=>1006, probe:denied, acl});
  expect(access.status).toBe('needs-grant');
  expect('advice' in access && access.advice).toContain('request_grant(kind:device, target:"/dev/kvm"');
  expect(acl).not.toHaveBeenCalled();
});
it('Reproduction R1: with a grant the host still denies, the agent asks the host admin and does not request another grant', () => {
  const access = prepareKvmAccess(['/dev/kvm'], {uid:()=>1006, probe:denied, acl:()=>{throw new Error('not owner');}});
  expect(access.status).toBe('host-denied');
  const advice = 'advice' in access ? access.advice : '';
  expect(advice).toContain('helper uid 1006');
  expect(advice).toContain('`sudo setfacl -m u:1006:rw /dev/kvm`');
  expect(advice).toContain('docs/android-kvm-access.md');
  expect(advice).toContain('another grant will not help');
  expect(advice).not.toContain('request_grant');
});
it('leaves an already usable device alone', () => {
  const acl = vi.fn();
  expect(prepareKvmAccess(['/dev/kvm'], {uid:()=>1006, probe:()=>{}, acl})).toEqual({status:'works'});
  expect(prepareKvmAccess([], {uid:()=>1006, probe:()=>{}, acl})).toEqual({status:'works'});
  expect(acl).not.toHaveBeenCalled();
});
it('reports a host without /dev/kvm as unavailable with no agent advice', () => {
  const access = prepareKvmAccess(['/dev/kvm'], {uid:()=>1006, probe:missing, acl:vi.fn()});
  expect(access).toEqual({status:'unavailable', detail:'no such file'});
});

it('sets only the exact KVM ACL, then verifies the real access probe', () => {
  vi.mocked(openSync).mockImplementationOnce(denied).mockReturnValueOnce(42);
  vi.mocked(spawnSync).mockReturnValue({status:0, stdout:'', stderr:''} as ReturnType<typeof spawnSync>);
  expect(prepareKvmAccess(['/dev/kvm'])).toEqual({status:'works'});
  expect(spawnSync).toHaveBeenCalledWith('setfacl', ['-m', `u:${process.getuid!()}:rw`, '/dev/kvm'], {encoding:'utf8',timeout:5_000});
  expect(openSync).toHaveBeenCalledTimes(2);
  expect(closeSync).toHaveBeenCalledWith(42);
});
