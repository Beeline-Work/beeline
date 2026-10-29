import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { keepCornerEmulator, prepareCornerAdb, stopKeptCornerEmulator } from '../apps/body/dist/corner-emulator.js';
const supervisor = await mkdtemp(join(process.env.HOME, 'corner-adb-proof-'));
const leaseRoot = join(supervisor,'beeline/workspaces/proof/shared-home/cache/android-leases');
const ids = ['corner-keep','corner-gone'];
const envs = [];
try {
 for (const [i,cornerId] of ids.entries()) {
  const root=join(supervisor,cornerId);
  await mkdir(root,{recursive:true});
  const env={...process.env, BEELINE_ANDROID_LEASE_ROOT:leaseRoot,BEELINE_ANDROID_INSTANCE_ROOT:join(root,'instances'),PATH:process.env.PATH,ANDROID_ADB_SERVER_PORT:String(6700+i)};
  delete env.ANDROID_SERIAL;
  delete env.ADB_SERVER_SOCKET;
  const host={androidHome:env.ANDROID_HOME,emulatorBinary:resolve(env.ANDROID_HOME,'emulator/emulator'),leaseRoot,instanceRoot:env.BEELINE_ANDROID_INSTANCE_ROOT,baseAvdHome:env.BEELINE_ANDROID_BASE_AVD_HOME,emulatorHome:join(root,'android'),path:env.PATH,home:root};
  await prepareCornerAdb(root,cornerId,env);
  const result=await keepCornerEmulator(cornerId,['-avd','se_test33','-no-window','-gpu','swiftshader_indirect','-memory','1024'],env,host);
  assert.equal(result.ok,true,JSON.stringify(result));
  const device=execFileSync(join(root,'corner-adb-bin/adb'),['devices'],{env,encoding:'utf8'});
  assert.deepEqual(device.trim().split('\n').slice(1),[result.serial+'\tdevice']);
  console.log('CORNER-ADB-1',cornerId,device.trim());
  await prepareCornerAdb(root,cornerId,env);
  const record=JSON.parse(await readFile(join(leaseRoot,'kept',cornerId+'.json'),'utf8'));
  assert.equal(env.ANDROID_SERIAL,result.serial);
  assert.equal(env.ANDROID_ADB_SERVER_PORT,String(record.port+2));
  assert.equal(execFileSync(join(root,'corner-adb-bin/adb'),['get-state'],{env,encoding:'utf8'}).trim(),'device');
  envs.push({root,env,serial:result.serial});
 }
 for (const {root,env,serial} of envs) {
  const devices=execFileSync(join(root,'corner-adb-bin/adb'),['devices'],{env,encoding:'utf8'});
  assert.deepEqual(devices.trim().split('\n').slice(1),[serial+'\tdevice']);
 }
 console.log('CORNER-ADB-1 PASS: concurrent corners each see exactly their own leased emulator');
} finally {
 for (const id of ids) await stopKeptCornerEmulator(supervisor,id);
 await rm(supervisor,{recursive:true,force:true});
}
