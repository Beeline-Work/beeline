import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sources = resolve(__dirname, '..');

/**
 * Characters that must never stand in for a mark on a label, button, action or
 * icon: arrows, crosses, checks, pluses, stars, gears, play/stop, boxes and dots.
 * Labels carry words; marks are drawn (`CloseGlyph`, `ChevronGlyph`,
 * `ExternalGlyph`, `Button.destination`). Same set as the label audit.
 */
const GLYPH =
  /[↗↘↙↖→←↑↓⟶⟵⇢⇠›‹»«▸▹▾▿▴▵▶▷◀◁►◄✕✖×✗✘✓✔☐☑⨯⌄⌃⌵✚＋□■▪▫⊘●○◉◎⬤★☆⚙⚠⚑✎✏🔗↻⟳⤴⤵⇗➜➔➤]/u;

/**
 * Status marks inside text or prose, not labels on controls (the audit's
 * "not label problems" list). Keyed `file|literal`. An entry that no longer
 * matches fails too, so this list only shrinks.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  // Step and result marks.
  'components/buzz/ActivityTimeline.tsx|✗': 'failed tool step',
  'app/(app)/beeline/chat/_chat-surface.tsx|✓': 'check result mark',
  'app/(app)/beeline/chat/_chat-surface.tsx|✗': 'check result mark',
  'components/buzz/CopiedToast.tsx|✓': 'copied confirmation',
  'components/buzz/MentionSuggestionMenu.tsx|✓': 'already-selected mention',
  'components/buzz/AgentSignInCard.tsx|✓ Looks like a ': 'sign-in code recognised',
  // State circles.
  'buzz/corner-display-state.ts|●': 'corner state circle',
  'buzz/corner-display-state.ts|○': 'corner state circle',
  'components/buzz/EmptyLedgerState.tsx|○': 'empty ledger state circle',
  'components/buzz/ConversationRow.tsx|●': 'live call dot',
  // Approved store-version comparison, a status line rather than a control.
  'components/StoreUpdateGate.tsx|→': 'installed to required store version',
  // Direction, ledger and archive marks in text.
  'app/(app)/beeline/settings/workbench/wallet.tsx|↓': 'payment direction',
  'app/(app)/beeline/settings/workbench/wallet.tsx|↑': 'payment direction',
  'buzz/tool-ledger.ts|✎': 'note step mark',
  'app/(app)/beeline/chat/_chat-surface.tsx|□ CORNER ARCHIVED · READ-ONLY': 'archived status line',
  'components/buzz/AgentSignInCard.tsx|Device-code sign-in must be on in ChatGPT → Settings → Security.':
    'prose menu path',
  // Unused files nothing imports.
  'components/buzz/WritePermissionOutcome.tsx|⊘ A PERSON MUST RESPOND': 'unused file',
  'components/buzz/WritePermissionOutcome.tsx|□ REQUEST EXPIRED · STILL READ-ONLY': 'unused file',
  'components/buzz/WritePermissionOutcome.tsx|□ CORNER COULD NOT OPEN · STILL READ-ONLY': 'unused file',
  'components/buzz/WritePermissionOutcome.tsx|□ EDITING DENIED · STILL READ-ONLY': 'unused file',
  'components/buzz/WritePermissionOutcome.tsx|□ WAITING FOR A PERSON': 'unused file',
  'components/buzz/CommunityInviteEntry.tsx|＋': 'unused file',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'vendor') continue;
      // A running browser proof's scratch copy (`mkdtemp`, six random letters), not app source.
      if (/-(?=[a-z0-9]*[A-Z0-9])[A-Za-z0-9]{6}$/.test(entry.name)) continue;
      walk(full, out);
    } else if (
      /\.(tsx?|jsx?)$/.test(entry.name) &&
      !/\.(test|spec|stories)\.|\.d\.ts$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Every string, template part and JSX text in `file` that carries an audited character. */
function glyphLiterals(file: string, text: string): string[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    let value: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      value = node.text;
    } else if (ts.isJsxText(node)) value = node.text.trim();
    if (value && GLYPH.test(value)) {
      const inImport = ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent);
      if (!inImport) found.push(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const hits = walk(sources).flatMap((file) => {
  const path = relative(sources, file);
  return glyphLiterals(file, readFileSync(file, 'utf8')).map((value) => `${path}|${value}`);
});

describe('label glyph guard', () => {
  it('finds no arrow, cross, check, plus, star or box typed into a label', () => {
    expect(hits.filter((hit) => !(hit in ALLOWED))).toEqual([]);
  });

  it('keeps only allowlist entries that still match', () => {
    expect(Object.keys(ALLOWED).filter((key) => !hits.includes(key))).toEqual([]);
  });

  it('flags a typed mark in a label, an action and a Text used as an icon', () => {
    const sample = [
      `<Button label="Open ↗" />`,
      `const actions = [{ label: 'Continue ›' }];`,
      `<Button icon={<Text>✕</Text>} />`,
      `<Pressable accessibilityLabel="Settings"><Text>⚙</Text></Pressable>`,
      `<Text style={styles.icon}>⚙️</Text>`,
      `<View accessibilityValue={{ text: '×' }} />`,
    ];
    for (const text of sample) expect(glyphLiterals('Sample.tsx', text)).toHaveLength(1);
    expect(glyphLiterals('Sample.tsx', `<Button label="Open in browser" destination="external" />`)).toEqual([]);
  });
});

describe('close controls', () => {
  // Every close and remove control from the label audit.
  const closeSites = [
    'components/buzz/ComputerSession.tsx',
    'components/buzz/ArtifactViewer.tsx',
    'components/buzz/DesktopArtifactPane.tsx',
    'components/buzz/TranscriptCard.tsx',
    'components/buzz/CommunityRail.tsx',
    'components/buzz/ConversationComposer.tsx',
    'components/buzz/RoomRosterSheet.tsx',
    'components/buzz/SlashVerbPicker.tsx',
    'components/DesktopRoomInspector.tsx',
    'components/UpdateReadyPrompt.tsx',
  ];

  it.each(closeSites)('%s closes through the shared CloseButton', (file) => {
    const text = readFileSync(join(sources, file), 'utf8');
    expect(text).toContain('<CloseButton');
  });

  it('draws no close from an icon font anywhere', () => {
    const iconFontClose = walk(sources).filter((file) =>
      /<Ionicons[^>]*name="close(?:-outline)?"/.test(readFileSync(file, 'utf8')),
    );
    expect(iconFontClose.map((file) => relative(sources, file))).toEqual([]);
  });
});
