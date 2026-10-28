import { expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
vi.mock('node:child_process', () => ({spawnSync: vi.fn()}));
vi.mock('node:fs', () => ({openSync: vi.fn(), closeSync: vi.fn()}));
import { prepareGrantedKvmAccess } from './kvm-device-access.js';
const denied = () => { throw Object.assign(new Error('permission denied'), {code:'EACCES'}); };
it('only an approved KVM grant attempts a host ACL for the helper user', () => {
  let allowed = false;
  const acl = vi.fn((uid: number) => { expect(uid).toBe(1006); allowed = true; });
  const dependencies = {uid:()=>1006, probe:()=>{ if (!allowed) denied(); }, acl};
  expect(prepareGrantedKvmAccess([], dependencies)).toBeUndefined();
  expect(prepareGrantedKvmAccess(['/dev/ttyUSB0'], dependencies)).toBeUndefined();
  expect(acl).not.toHaveBeenCalled();
  expect(prepareGrantedKvmAccess(['/dev/kvm'], dependencies)).toBeUndefined();
  expect(acl).toHaveBeenCalledTimes(1);
  expect(acl).toHaveBeenCalledWith(1006);
  expect(allowed).toBe(true);
});
it('reports the required host action when an unprivileged helper cannot repair the ACL', () => {
  const message = prepareGrantedKvmAccess(['/dev/kvm'], {uid:()=>1006, probe:denied, acl:()=>{throw new Error('not owner');}});
  expect(message).toContain('/dev/kvm permission denied');
  expect(message).toContain('docs/android-kvm-access.md');
});
it('leaves an already usable device alone', () => {
  const acl = vi.fn();
  prepareGrantedKvmAccess(['/dev/kvm'], {uid:()=>1006, probe:()=>{}, acl});
  expect(acl).not.toHaveBeenCalled();
});

it('sets only the exact KVM ACL, then verifies the real access probe', () => {
  vi.mocked(openSync).mockImplementationOnce(denied).mockReturnValueOnce(42);
  vi.mocked(spawnSync).mockReturnValue({status:0, stdout:'', stderr:''} as ReturnType<typeof spawnSync>);
  expect(prepareGrantedKvmAccess(['/dev/kvm'])).toBeUndefined();
  expect(spawnSync).toHaveBeenCalledWith('setfacl', ['-m', `u:${process.getuid!()}:rw`, '/dev/kvm'], {encoding:'utf8',timeout:5_000});
  expect(openSync).toHaveBeenCalledTimes(2);
  expect(closeSync).toHaveBeenCalledWith(42);
});
