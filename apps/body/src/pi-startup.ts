/**
 * Patch only the selected pi-acp entry as Node loads it. Installed packages stay
 * untouched; the hook belongs to this ACP process alone.
 */
const LOADER = String.raw`
let entry;
export function initialize(data) { entry = data.entry; }
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== entry) return result;
  try {
    let source = String(result.source);
    function replace(from, to) {
      if (source.split(from).length !== 2) throw new Error('Unsupported pi-acp startup source: ' + from.slice(0, 70));
      source = source.replace(from, to);
    }
    replace('    const updateNotice = buildUpdateNotice();', '    const updateNotice = null;');
    const startupStart = source.indexOf('function buildStartupInfo(opts) {');
    const versionStart = source.indexOf('  try {', startupStart);
    const versionEnd = source.indexOf('  const addSection =', versionStart);
    if (startupStart < 0 || versionStart < 0 || versionEnd < 0 || !source.slice(versionStart, versionEnd).includes('spawnSync("pi", ["--version"]')) {
      throw new Error('Unsupported pi-acp startup version');
    }
    const quietStart = source.indexOf('    const quietStartup = getQuietStartup(params.cwd);');
    const sessionStart = source.lastIndexOf('  async newSession(params) {', quietStart);
    const sessionSetup = source.slice(sessionStart, quietStart);
    // Check the original scopes before adding references to adapter-owned names.
    if (!/\bconst md = \[\];/.test(source.slice(startupStart, versionStart)) ||
        sessionStart < 0 || !/\bconst session =/.test(sessionSetup) ||
        !/\bthis\.conn\b/.test(sessionSetup)) {
      throw new Error('Unsupported pi-acp startup bindings');
    }
    source = source.slice(0, versionStart) +
      '  const version = __beelineInstalledPiVersion(opts.cwd);\n  if (version) md.push("pi v" + version, "---", "");\n' + source.slice(versionEnd);
    replace('    const quietStartup = getQuietStartup(params.cwd);',
      '    const quietStartup = getQuietStartup(params.cwd);\n' +
      '    const __beelinePiVersion = __beelineInstalledPiVersion(params.cwd);\n' +
      '    if (!__beelinePiVersion) setTimeout(() => {\n' +
      '      void __beelineReadPiVersion(params.cwd).then(version => {\n' +
      '        if (version) return this.conn.sessionUpdate({ sessionId: session.sessionId, update: {\n' +
      '          sessionUpdate: "session_info_update", _meta: { piAcp: { version } }\n' +
      '        } });\n' +
      '      }).catch(() => {});\n' +
      '    }, 0);');
    const preamble = __BEELINE_PREAMBLE__;
    const shebangEnd = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
    source = source.slice(0, shebangEnd) + preamble + source.slice(shebangEnd);
    return { ...result, source };
  } catch {
    // An upstream layout change must never prevent the adapter from starting.
    return result;
  }
}
`;

const VERSION_PREAMBLE = String.raw`
import { realpathSync as __beelineRealpath, readFileSync as __beelineReadFile, accessSync as __beelineAccess, constants as __beelineFsConstants, statSync as __beelineStat } from 'node:fs';
import { delimiter as __beelineDelimiter, dirname as __beelineDirname, resolve as __beelineResolve, isAbsolute as __beelineAbsolute } from 'node:path';
import { execFile as __beelineExecFile } from 'node:child_process';
const __beelinePiCommand = process.env.PI_ACP_PI_COMMAND ?? (process.platform === 'win32' ? 'pi.cmd' : 'pi');
function __beelineInstalledPiVersion(cwd = process.cwd()) {
  const candidates = __beelineAbsolute(__beelinePiCommand) || /[/\\]/.test(__beelinePiCommand)
    ? [__beelineResolve(cwd, __beelinePiCommand)]
    : (process.env.PATH ?? '').split(__beelineDelimiter).map(dir => __beelineResolve(cwd, dir, __beelinePiCommand));
  for (const candidate of candidates) {
    let executable;
    try {
      __beelineAccess(candidate, __beelineFsConstants.X_OK);
      if (!__beelineStat(candidate).isFile()) continue;
      executable = __beelineRealpath(candidate);
    } catch { continue; }
    let dir = __beelineDirname(executable);
    for (let depth = 0; depth < 6; depth++) {
      try {
        const pkg = JSON.parse(__beelineReadFile(__beelineResolve(dir, 'package.json'), 'utf8'));
        const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
        if (typeof pkg.version === 'string' && /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(pkg.version) &&
            bins.some(bin => typeof bin === 'string' && __beelineRealpath(__beelineResolve(dir, bin)) === executable)) return pkg.version;
      } catch {}
      const parent = __beelineDirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // The first executable on PATH owns the version, even without metadata.
    return undefined;
  }
}
function __beelineReadPiVersion(cwd = process.cwd()) {
  return new Promise(resolve => {
    __beelineExecFile(__beelinePiCommand, ['--version'], { cwd, encoding: 'utf8', timeout: 2000, maxBuffer: 4096 }, (error, stdout, stderr) => {
      const version = String(stdout || stderr).trim().replace(/^v/i, '');
      resolve(!error && /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version) ? version : undefined);
    });
  });
}
`;

/** NODE_OPTIONS reaches sandbox wrappers too; only pi-acp registers a hook. */
export function piStartupEnvironment(
  label: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!/(^|[/\\])pi-acp(?:\.[a-z]+)?$/i.test(label)) return env;
  const loader = LOADER.replace('__BEELINE_PREAMBLE__', JSON.stringify(VERSION_PREAMBLE));
  const preload = `
import { register } from 'node:module';
import { realpathSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let entry;
try {
  const main = realpathSync(process.argv[1]);
  const pkg = JSON.parse(readFileSync(resolve(dirname(main), '../package.json'), 'utf8'));
  if (pkg.name === 'pi-acp') entry = pathToFileURL(main).href;
} catch {}
if (entry) {
  // Keep the loader local to ACP; Pi and its tools retain the original options.
  ${env.NODE_OPTIONS === undefined ? 'delete process.env.NODE_OPTIONS;' : `process.env.NODE_OPTIONS = ${JSON.stringify(env.NODE_OPTIONS)};`}
  register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, { data: { entry } });
}
`;
  const option = `--import=data:text/javascript,${encodeURIComponent(preload)}`;
  return { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, option].filter(Boolean).join(' ') };
}
