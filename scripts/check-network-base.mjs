// Run the trusted base's scanners against the proposed tree. The ordinary
// head checks remain necessary for newly introduced coverage. This check
// prevents a changed scanner from approving its own relaxed boundary policy.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function checkTrustedNetworkBase(root, base) {
  root = path.resolve(root);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // Resolve once, before inspecting files; missing or malformed bases fail closed.
  if (!base || base.startsWith('-')) throw new Error('--base requires a trusted git ref');
  const commit = git(['rev-parse', '--verify', `${base}^{commit}`]).trim();
  const phoneFile = 'scripts/phone-network-channels.mjs';
  const routerFile = 'scripts/router-boundaries.mjs';
  const phoneSource = git(['show', `${commit}:${phoneFile}`]);
  const hasRouter = git(['ls-tree', '--name-only', commit, '--', routerFile]).trim() === routerFile;
  const proof = path.join(root, '.beeline-proof');
  mkdirSync(proof, { recursive: true });
  const directory = mkdtempSync(path.join(proof, 'network-base-'));
  try {
    // Keep module resolution on the checked-out dependency installation; do
    // not install packages or evaluate any proposed scanner source.
    symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    writeFileSync(path.join(directory, 'phone-network-channels.mjs'), phoneSource);
    const phone = await import(pathToFileURL(path.join(directory, 'phone-network-channels.mjs')).href);
    const errors = phone.judgeChannels(phone.scanPhoneTree(root),
      JSON.parse(readFileSync(path.join(root, phone.ALLOWLIST_PATH), 'utf8')),
      phone.allowlistAtRef(root, commit)).map(error => `trusted phone: ${error}`);
    if (hasRouter) {
      writeFileSync(path.join(directory, 'router-boundaries.mjs'), git(['show', `${commit}:${routerFile}`]));
      const router = await import(pathToFileURL(path.join(directory, 'router-boundaries.mjs')).href);
      const scanned = router.scanRouterTree(root);
      errors.push(...scanned.errors.map(error => `trusted router: ${error}`));
      errors.push(...router.judgeInventory(scanned.sites,
        JSON.parse(readFileSync(path.join(root, router.INVENTORY), 'utf8')),
        router.baselineInventory(root, commit, scanned.sites)).map(error => `trusted router: ${error}`));
    }
    return { base: commit, routerAtBase: hasRouter, errors };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let root = process.cwd(), base;
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (!['--root', '--base'].includes(flag) || !value || value.startsWith('-'))
        throw new Error('Expected --root <directory> and --base <trusted git ref>');
      if (flag === '--root') root = value; else base = value;
    }
    const result = await checkTrustedNetworkBase(root, base);
    for (const error of result.errors) console.error(error);
    if (result.errors.length) process.exitCode = 1;
    else console.log(`Trusted network policy passed at ${result.base}; router scanner ${result.routerAtBase ? 'present' : 'not yet at base (head bootstrap check remains required)'}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
