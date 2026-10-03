import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sources = resolve(__dirname, '..');

// These are status marks, badges, identity faces, and vote washes. None is a
// button plate. Every new accent-filled style must be classified here or use
// the button palette instead; this makes a local Pressable fill fail CI.
const decorativeAccentFills = new Set([
  'app/(app)/join/[token].tsx:badgeDot',
  'app/(app)/beeline/workflow-run.tsx:liveDot',
  'components/DesktopWorkPaneHandle.tsx:arrived',
  'components/buzz/ConversationRow.tsx:dot',
  'components/buzz/DesktopWorkspaceRail.tsx:pill',
  'components/buzz/Ledger.tsx:bylineDotViewer',
  'components/buzz/MemberPickerSheet.tsx:checkOn',
  'components/buzz/MonoHull.tsx:mechanismRailLive',
  'components/buzz/MonoHull.tsx:stateCircleNeedsYou',
  'components/buzz/MonoHull.tsx:stateCircleFillBrass',
  'components/buzz/MonoHull.tsx:activityTipDot',
  'components/buzz/MonoHull.tsx:waveSegmentLive',
  'components/buzz/NeedsYouCell.tsx:rail',
  'components/buzz/RoomCatchUpControls.tsx:badge',
  'components/buzz/RoomListToolbar.tsx:selectedRule',
  'components/buzz/RoomListToolbar.tsx:needsCount',
  'components/buzz/StateDot.tsx:pulse',
  'components/buzz/TranscriptCard.tsx:initialValues',
  'components/buzz/TranscriptCard.tsx:rowRule',
  'components/buzz/TranscriptCard.tsx:choiceWash',
  'components/buzz/TranscriptCard.tsx:choiceWashLeader',
  'components/buzz/TranscriptCard.tsx:choiceLetterSelected',
  'components/buzz/TranscriptScrubber.tsx:handle',
]);

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : [];
  });
}

function styleName(node: ts.PropertyAssignment): string {
  let parent: ts.Node | undefined = node.parent;
  while (parent && !ts.isPropertyAssignment(parent)) parent = parent.parent;
  return parent ? parent.name.getText() : '(inline)';
}

describe('button palette boundary', () => {
  it('forbids brass fills on button-like controls in native and web source', () => {
    const violations: string[] = [];
    for (const path of [...filesUnder(join(sources, 'app')), ...filesUnder(join(sources, 'components'))]) {
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const file = relative(sources, path);
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAssignment(node) && /^(backgroundColor|background)$/.test(node.name.getText())) {
          const value = node.initializer.getText(source);
          if (/(?:\.accent|\.brassWash(?:Strong)?|\bbrassWash\b|#(?:b08a4a|8a6323)\b)/i.test(value)) {
            const name = styleName(node);
            if (!decorativeAccentFills.has(`${file}:${name}`)) violations.push(`${file}:${name} = ${value}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });

  it('keeps links, mentions, and the profile @ on the brass accent', () => {
    expect(readFileSync(join(sources, 'components/buzz/MonoMarkdown.tsx'), 'utf8'))
      .toContain('mention: { color: theme.buzz.accent }');
    expect(readFileSync(join(sources, 'components/buzz/ProfileIdentity.tsx'), 'utf8'))
      .toContain('at: { color: theme.buzz.accent }');
    expect(readFileSync(join(sources, 'theme.ts'), 'utf8'))
      .toContain('textLink: buzz.accent');
  });
});
