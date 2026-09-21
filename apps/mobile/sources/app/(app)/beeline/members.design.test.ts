import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { beelineThemes } from '@/buzz/groknight';

const source = readFileSync(new URL('./members.tsx', import.meta.url), 'utf8');
const memberRow = readFileSync(
  new URL('../../../components/buzz/MemberRosterRow.tsx', import.meta.url),
  'utf8',
);

function styleBlock(text: string, name: string): string {
  const start = text.indexOf(`    ${name}: {`);
  expect(start, `missing style ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated style ${name}`);
}

describe('Members page layout contract', () => {
  it('carries no seeded-souls Workspace switch (removed C99)', () => {
    // The per-agent seeded soul (singular `seededSoul`, the soul editor's
    // restore-to-default) stays; only the removed Workspace-wide plural
    // switch and its control must be gone.
    expect(source).not.toMatch(/seededSouls\b/);
    expect(source).not.toMatch(/workspace-seeded-souls/);
    expect(source).not.toContain('setWorkspaceSeededSouls');
    expect(source).not.toContain('Seeded souls');
  });

  it('renders two sections only, People before Agents, with every person inside People (C79)', () => {
    // The old layout lifted owners into a headerless pinned block above Agents
    // and filtered them out of the People rows, so the People count and the rows
    // beneath it disagreed by construction. One People section now holds every
    // person (owner included, carrying its role like any other) and the owner is
    // never special-cased in the layout.
    expect(source).not.toMatch(/pinnedOwners|listedPeople/);
    const peopleStart = source.indexOf('testID="members-people-section"');
    const agentsStart = source.indexOf('testID="members-agents-section"');
    expect(peopleStart).toBeGreaterThanOrEqual(0);
    expect(agentsStart).toBeGreaterThanOrEqual(0);
    expect(peopleStart).toBeLessThan(agentsStart);
    const people = source.slice(peopleStart, agentsStart);
    expect(people).toContain('{people.map((member) => personRow(member))}');
    // No person row can render outside the People section.
    expect(source.slice(agentsStart)).not.toContain('personRow(');
  });

  it('aligns the section + on the same trailing axis as the row chevron (C99)', () => {
    // The row's trailing chevron sits flush against the row's own padding
    // edge; the section head's + control is a 44pt hit target, so its
    // content must align to that same trailing edge rather than centering
    // inside the hit box, or the two visually disagree by half the glyph
    // width (captain report, second complaint on this page).
    expect(styleBlock(source, 'sectionHeadRow')).toContain('paddingRight: hull.space.sm');
    expect(styleBlock(memberRow, 'row')).toContain('paddingHorizontal: hull.space.sm');
    expect(styleBlock(source, 'sectionAdd')).toContain("alignItems: 'flex-end'");
  });

  it('expands agent settings under the tapped row and rotates that row’s chevron', () => {
    const agentsStart = source.indexOf('testID="members-agents-section"');
    const agents = source.slice(agentsStart, source.indexOf('</KeyboardAwareScrollView>', agentsStart));
    // The disclosure mark is the shared drawn chevron at the one row size,
    // turned down when the row is open — not `⌄`/`›` set in the hero role.
    expect(agents).toContain('<ChevronGlyph');
    expect(agents).toContain("direction={open ? 'down' : 'right'}");
    expect(agents).toContain('size={CHEVRON_ROW_SIZE}');
    expect(agents).toContain('agent-${selectedAgent.agent.identity.pubkey}-model-config');
    expect(agents).toContain('open &&');
    expect(source.indexOf('testID="members-agents-section"')).toBeLessThan(
      source.indexOf('agent-${selectedAgent.agent.identity.pubkey}-model-config'),
    );
    const afterAgents = source.slice(source.indexOf('</KeyboardAwareScrollView>'));
    expect(afterAgents).not.toContain('model-config');
  });

  it('removes an agent from one compact red control beside its identity copy', () => {
    // The old danger zone — a red rule, a paragraph of warning copy and a
    // full-width destructive button at the foot of the panel — is gone. The
    // confirm dialog already states the whole consequence of removal, so the
    // page keeps only the control, sat next to the handle and owner byline.
    expect(source).not.toContain('dangerZone');
    expect(source).not.toContain('dangerCopy');
    expect(source).not.toContain('BAN AGENT');
    expect(source).not.toContain('Ban this agent from every Room');
    const heading = source.slice(
      source.indexOf('<View style={styles.detailHeading}>'),
      source.indexOf('testID="close-agent-settings"'),
    );
    expect(heading).toContain('testID="agent-handle"');
    expect(heading).toContain('testID="agent-owner"');
    expect(heading).toContain('testID="remove-agent"');
    expect(heading).toContain('style={styles.removeAgentControl}');
  });

  it('keeps the compact control at the 44pt target and above the contrast floors', () => {
    // Compact is the width and the single word, never a shrunken hit target.
    expect(styleBlock(source, 'removeAgentControl')).toContain('minHeight: 44');
    expect(styleBlock(source, 'removeAgentControl')).toContain('borderColor: hull.dialogDanger');
    expect(styleBlock(source, 'removeAgentText')).toContain('color: hull.textPrimary');

    const channel = (hex: string) => {
      const part = parseInt(hex, 16) / 255;
      return part <= 0.03928 ? part / 12.92 : Math.pow((part + 0.055) / 1.055, 2.4);
    };
    const luminance = (hex: string) => {
      const value = hex.replace('#', '');
      const [r, g, b] = [0, 2, 4].map((at) => channel(value.slice(at, at + 2)));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (ink: string, ground: string) => {
      const [brighter, darker] = [luminance(ink), luminance(ground)].sort((x, y) => y - x);
      return (brighter + 0.05) / (darker + 0.05);
    };

    // The panel is a raised surface inside the page, so both grounds count.
    // The label holds the 4.5:1 text floor; the red border holds the 3:1
    // non-text floor. `dialogDanger` as small ink would hold neither — 4.36:1
    // on Obsidian, 3.81:1 on Bone — which is why the word is not the red part.
    for (const set of Object.values(beelineThemes)) {
      for (const ground of [set.bgBase, set.bgRaised]) {
        expect(contrast(set.textPrimary, ground)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(set.dialogDanger, ground)).toBeGreaterThanOrEqual(3);
        expect(contrast(set.dialogDanger, ground)).toBeLessThan(4.5);
      }
    }
  });
});
