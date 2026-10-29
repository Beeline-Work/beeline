/** Prepare isolated source trees for the UI audit; never export private app APIs. */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const destination = process.argv[2];
const ref = process.argv[3] ?? 'working';
if (!destination || !path.isAbsolute(destination))
  throw new Error('Pass an absolute scratch directory and optional git ref (default: working).');
mkdirSync(destination, { recursive: true });
const archive = path.join(destination, 'source.tar');
execFileSync(
  'git',
  [
    'archive',
    '--output=' + archive,
    ref === 'working' ? 'HEAD' : ref,
    'apps/mobile/sources',
    'apps/mobile/package.json',
    'apps/mobile/tsconfig.json',
  ],
  { cwd: repo },
);
execFileSync('tar', ['-xf', archive, '-C', destination]);
unlinkSync(archive);
mkdirSync(path.join(destination, 'apps/mobile/scripts'), { recursive: true });
const mobile = path.join(destination, 'apps/mobile');
if (ref === 'working') {
  const files = execFileSync('git', ['ls-files', '-z', 'apps/mobile'], { cwd: repo })
    .toString()
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    const target = path.join(destination, file);
    if (existsSync(path.join(repo, file))) {
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(repo, file), target);
    }
  }
}
if (!existsSync(path.join(mobile, 'node_modules')))
  symlinkSync(
    path.join(repo, 'apps/mobile/node_modules'),
    path.join(mobile, 'node_modules'),
    'dir',
  );
copyFileSync(
  path.join(here, 'scene.tsx.template'),
  path.join(mobile, 'scripts/ui-repair-audit-proof.tsx'),
);
for (const [file, name] of [
  ['sources/components/buzz/WorkflowRunLine.tsx', 'OpenedCorner'],
  ['sources/app/(app)/beeline/chat/RoomMessageVariants.tsx', 'AttachmentCard'],
]) {
  const source = path.join(mobile, file);
  writeFileSync(
    source.replace('.tsx', '.audit.tsx'),
    readFileSync(source, 'utf8') + `\nexport { ${name} };\n`,
  );
}
const file = path.join(mobile, 'sources/components/DesktopRoomInspector.tsx');
const source = readFileSync(file, 'utf8');
const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let header;
function walk(node) {
  if (
    ts.isJsxElement(node) &&
    node.openingElement.getText(tree).includes('desktop-work-cockpit-header')
  )
    header = node.getText(tree);
  ts.forEachChild(node, walk);
}
walk(tree);
if (!header) throw new Error('Cockpit header not found');
writeFileSync(
  file.replace('.tsx', '.audit.tsx'),
  source +
    `\nexport function AuditInspectorHeader(){const summary=undefined,title='Review phone layouts',onClose=()=>{},onOpenInMain=()=>{};return (${header});}\n`,
);
console.log(mobile);
