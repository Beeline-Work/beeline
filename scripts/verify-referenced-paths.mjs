#!/usr/bin/env node
// Nothing type-checks a command string, so a manifest, workflow, unit or skill
// keeps naming a file long after the file is deleted. PR #3655 deleted 1,000+
// files and left 116 npm scripts, a release-workflow step, three required
// checks' tests and the review skill's lint command pointing at nothing.
//
// This is an existence check, nothing more. It collects repository paths named
// by package.json scripts, GitHub workflow and composite-action files, tracked
// systemd units and the shipped agent skills, and fails on any that matches no
// tracked file. A path is a token with at least one `/` whose first segment is
// a top-level directory of the repository or of a workspace. It resolves
// against the repository root, the naming package, every workspace and every
// `working-directory:` in the same workflow, because the same file is spelled
// several ways (`-w @beeline/server -- --run src/…test.ts`). A path may name a
// file, a directory, or a module or test filter without its extension
// (`npx vitest run sources/buzz/calm-lint`). `*` matches within a segment and
// `**` across segments, so a glob passes while it still selects a file.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';

// A token carrying `$` or `{` is expanded by a runner; one under a build output
// or dependency directory names an artifact the command itself produces.
const PATH_TOKEN = /(?<![\w.@$%{}/-])(?:\.{1,2}\/)*[\w.@()[\]*+-]+(?:\/[\w.@()[\]*+-]*)+/g;
const GENERATED = /(?:^|\/)(?:dist|build|node_modules|\.turbo|\.expo|out|coverage)(?:\/|$)|-out(?:\/|$)/;

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const trackedSet = new Set(tracked);
const directories = new Set(tracked.flatMap((file) =>
  file.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'))));
const manifests = tracked.filter((file) => /(?:^|\/)package\.json$/.test(file)
  && (file === 'package.json' || /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file)));
const workspaces = manifests.map((file) => dirname(file)).filter((dir) => dir !== '.');
const topLevel = (base) => new Set(tracked
  .filter((file) => !base || file.startsWith(`${base}/`))
  .map((file) => (base ? file.slice(base.length + 1) : file).split('/'))
  .filter((parts) => parts.length > 1)
  .map((parts) => parts[0]));
const roots = new Map(['', ...workspaces].map((base) => [base, topLevel(base)]));

const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
function resolves(reference, bases) {
  for (const base of bases) {
    const path = posix.normalize(base ? `${base}/${reference}` : reference).replace(/\/$/, '');
    if (path.startsWith('..')) continue;
    if (path.includes('*')) {
      const glob = new RegExp(`^${escape(path).replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}(?:/|$)`);
      if (tracked.some((file) => glob.test(file))) return true;
      continue;
    }
    if (trackedSet.has(path) || directories.has(path)) return true;
    // A module specifier or test filter without its extension.
    const stem = `${path}.`;
    if (tracked.some((file) => file.startsWith(stem) && !file.slice(stem.length).includes('/'))) return true;
  }
  return false;
}

const candidates = [];
function check(source, text, bases) {
  // hashFiles() may legitimately match nothing.
  const searchable = bases.filter((base) => roots.has(base));
  const scanned = text.replace(/hashFiles\([^)]*\)/g, '');
  for (const { 0: token, index } of scanned.matchAll(PATH_TOKEN)) {
    if (/[$%{]/.test(scanned[index + token.length] ?? '')) continue;
    const reference = token.replace(/^\(+/, '').replace(/[.,:;]+$/, '');
    if (/[${}]/.test(reference) || reference.includes('://') || GENERATED.test(reference)) continue;
    // An unbalanced parenthesis is a regular expression fragment such as
    // `^apps/(body|server)/`; Expo route groups like `(app)/` are balanced.
    if ((reference.match(/\(/g) ?? []).length !== (reference.match(/\)/g) ?? []).length) continue;
    const first = reference.replace(/^(?:\.{1,2}\/)+/, '').split('/')[0];
    const relative = reference.startsWith('.');
    if (!relative && !searchable.some((base) => roots.get(base).has(first))) continue;
    candidates.push({ source, reference, bases });
  }
}

for (const manifest of manifests) {
  const base = dirname(manifest) === '.' ? '' : dirname(manifest);
  const { scripts = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const [name, command] of Object.entries(scripts))
    check(`${manifest} scripts.${name}`, command, [base, '', ...workspaces]);
}

const workflowFiles = tracked.filter((file) => /^\.github\/(?:workflows|actions)\/.*\.ya?ml$/.test(file));
for (const file of workflowFiles) {
  const text = readFileSync(file, 'utf8');
  const workingDirectories = [...text.matchAll(/working-directory:\s*['"]?([\w./-]+)/g)]
    .map(([, dir]) => posix.normalize(dir).replace(/\/$/, ''));
  // An upload, download or cache `path:` names what a job produces.
  let outputIndent = -1;
  for (const [index, line] of text.split('\n').entries()) {
    const indent = line.search(/\S/);
    if (outputIndent >= 0 && (indent < 0 || indent > outputIndent)) continue;
    outputIndent = -1;
    const output = /^(\s*)path:\s*(\|)?/.exec(line);
    if (output) {
      if (output[2]) outputIndent = output[1].length;
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    check(`${file}:${index + 1}`, line, ['', ...workspaces, ...workingDirectories]);
  }
}

// Units name install locations; a repository path is the suffix that starts at
// a top-level directory (`%h/…/checkout/scripts/log-walk/host-walk.sh`).
for (const file of tracked.filter((path) => /\.(?:service|timer|socket|path)$/.test(path))) {
  for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (!/^(?:Exec\w*|WorkingDirectory|EnvironmentFile)=/.test(line)) continue;
    const repositoryPaths = line.split(/\s+/).flatMap((word) => {
      const parts = word.replace(/^[\w-]+=/, '').split('/');
      const start = parts.findIndex((part, at) => at < parts.length - 1 && roots.get('').has(part));
      return start < 0 ? [] : [parts.slice(start).join('/')];
    });
    check(`${file}:${index + 1}`, repositoryPaths.join(' '), ['']);
  }
}

// Skills shipped to agents: Beeline's own skill sources and any SKILL.md.
for (const file of tracked.filter((path) => /^apps\/body\/src\/[^/]*-skill\.ts$|(?:^|\/)SKILL\.md$/.test(path))) {
  for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries())
    check(`${file}:${index + 1}`, line, ['', ...workspaces]);
}

// A git-ignored path is an artifact a build or release produces (web/dl/…).
const unresolved = candidates.filter(({ reference, bases }) => !resolves(reference, bases));
// check-ignore exits 1 when it matches nothing, so read its output, not its status.
const ignoredCheck = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
  encoding: 'utf8',
  input: unresolved.map(({ reference }) => posix.normalize(reference)).join('\n'),
});
if (ignoredCheck.status !== 0 && ignoredCheck.status !== 1) throw new Error(`git check-ignore failed: ${ignoredCheck.stderr}`);
const ignored = new Set(ignoredCheck.stdout.split('\n').filter(Boolean));
const missing = unresolved
  .filter(({ reference }) => !ignored.has(posix.normalize(reference)))
  .map(({ source, reference }) => `  ${source}  ${reference}`);
if (missing.length > 0) {
  console.error(`These references name no tracked file:\n\n${missing.join('\n')}\n`);
  console.error('Point the reference at the file that survives, or remove the reference.');
  console.error('A deleted file is not permission to restore the feature it served.');
  process.exit(1);
}
console.log(`Referenced paths: ${candidates.length} reference(s) in scripts, workflows, units and skills checked, all resolve.`);
