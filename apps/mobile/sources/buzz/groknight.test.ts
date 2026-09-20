import { describe, expect, it } from 'vitest';
import { beelineThemes, groknight, layout, space, typeRoles } from './groknight';

describe('Beeline theme tokens', () => {
  it('ships Obsidian Refined as the default token set', () => {
    expect(groknight).toMatchObject({
      name: 'obsidian',
      // Speakeasy brand canvas — the app-wide background at the token level.
      bgTerminal: '#14091A',
      bgBase: '#14091A',
      textPrimary: '#f0f0f3',
      textSecondary: '#c9c9d1',
      textMuted: '#83838d',
      border: '#291e33',
      accent: '#b08a4a',
      diffAdded: '#3FB950',
      diffRemoved: '#F85149',
      proseRegular: 'SpaceGrotesk-Regular',
    });
  });

  it('keeps content brighter than chrome and reserves mono for identity', () => {
    // Obsidian Refined (dark) and Bone (light) are the two shipped sets.
    expect(Object.keys(beelineThemes)).toEqual(['obsidian', 'bone']);
    for (const theme of Object.values(beelineThemes)) {
      expect(theme.textPrimary).not.toBe(theme.textMuted);
      expect(theme.ledgerBright).toBe(theme.textPrimary);
      expect(theme.monoRegular).toBe('IBMPlexMono-Regular');
      // ONE message size: no lead/prose size split.
      expect(theme.leadSize).toBe(theme.proseSize);
      expect(theme.proseMedium).toBeTruthy();
    }
  });
});

describe('Speakeasy canvas alignment', () => {
  it('sets Obsidian to the Speakeasy dark brand canvas and Bone to its light counterpart', () => {
    expect(beelineThemes.obsidian.bgVoid).toBe('#14091A');
    expect(beelineThemes.obsidian.bgTerminal).toBe('#14091A');
    expect(beelineThemes.obsidian.bgBase).toBe('#14091A');
    expect(beelineThemes.obsidian.avatarGround).toBe('#14091A');
    expect(beelineThemes.bone.bgVoid).toBe('#F3EEE4');
    expect(beelineThemes.bone.bgTerminal).toBe('#F3EEE4');
    expect(beelineThemes.bone.bgBase).toBe('#F3EEE4');
    expect(beelineThemes.bone.avatarGround).toBe('#F3EEE4');
    for (const theme of Object.values(beelineThemes)) {
      // Every screen reads one canvas value, whichever set is active.
      expect(theme.bgVoid).toBe(theme.bgTerminal);
      expect(theme.bgTerminal).toBe(theme.bgBase);
      expect(theme.avatarGround).toBe(theme.bgVoid);
    }
  });

  it('keeps every elevation stop moving away from the canvas, in ladder order', () => {
    // Luminance proxy: the green channel dominates perceived brightness here
    // and every stop shares a near-identical hue direction, so ordering on it
    // is a faithful check that no stop drifted back toward its canvas.
    // Obsidian's canvas sits near black, so its ladder climbs toward mid-gray
    // (brighter); Bone's canvas sits near white, so its ladder descends
    // toward mid-gray (darker) — same ladder, canvas-relative direction
    // flipped by `theme.dark`.
    const lum = (hex: string) => {
      const value = hex.replace('#', '');
      const r = parseInt(value.slice(0, 2), 16);
      const g = parseInt(value.slice(2, 4), 16);
      const b = parseInt(value.slice(4, 6), 16);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const theme of Object.values(beelineThemes)) {
      const sign = theme.dark ? 1 : -1;
      const away = (hex: string) => sign * lum(hex);
      const canvas = away(theme.bgBase);
      expect(away(theme.bgRaised)).toBeGreaterThanOrEqual(canvas);
      expect(away(theme.bgHighlight)).toBeGreaterThan(canvas);
      // Ledger deliberately shares one stop for highlight and hover.
      expect(away(theme.bgHover)).toBeGreaterThanOrEqual(away(theme.bgHighlight));
      expect(away(theme.bgPressed)).toBeGreaterThan(away(theme.bgHighlight));
      expect(away(theme.bgTexturePeak)).toBeGreaterThan(away(theme.bgPressed));
      // The unread-row ground lift sits exactly one step above the canvas —
      // an area cue for unread rows that must never outrank selection
      // (bgHighlight) or hover.
      expect(away(theme.bgUnread)).toBeGreaterThan(canvas);
      expect(away(theme.bgUnread)).toBeLessThan(away(theme.bgHighlight));
      // Hairlines must stay visible against both the canvas and raised surfaces.
      expect(away(theme.border)).toBeGreaterThan(canvas);
    }
  });
});

describe('The quiet tier holds a WCAG-AA floor', () => {
  const channel = (hex: string) => {
    const value = hex.replace('#', '');
    const c = parseInt(value, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
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

  it('lifts ledgerQuiet above 4.5:1 on every resting ground in both themes', () => {
    expect(beelineThemes.obsidian.ledgerQuiet).toBe('#90909B');
    expect(beelineThemes.bone.ledgerQuiet).toBe('#6F6455');
    expect(beelineThemes.obsidian.brassWash).toBe('rgba(176,138,74,0.18)');
    expect(beelineThemes.obsidian.brassWashStrong).toBe('rgba(176,138,74,0.28)');
    expect(beelineThemes.bone.brassWash).toBe('rgba(138,99,35,0.18)');
    expect(beelineThemes.bone.brassWashStrong).toBe('rgba(138,99,35,0.28)');
    for (const set of Object.values(beelineThemes)) {
      for (const ground of [set.bgBase, set.bgRaised, set.bgCode, set.bgUnread]) {
        expect(contrast(set.ledgerQuiet, ground)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('lifts Two Inks roles above a 3:1 floor on the canvas in both themes', () => {
    expect(beelineThemes.obsidian.syntaxStructure).toBe('#6c6c76');
    expect(beelineThemes.obsidian.syntaxName).toBe('#a58ec6');
    expect(beelineThemes.obsidian.syntaxValue).toBe('#a8cde8');
    expect(beelineThemes.bone.syntaxStructure).toBe('#8B7F6E');
    expect(beelineThemes.bone.syntaxName).toBe('#6b5a83');
    expect(beelineThemes.bone.syntaxValue).toBe('#1e4460');
    for (const set of Object.values(beelineThemes)) {
      expect(contrast(set.syntaxStructure, set.bgBase)).toBeGreaterThanOrEqual(3);
      expect(contrast(set.syntaxName, set.bgBase)).toBeGreaterThanOrEqual(3);
      expect(contrast(set.syntaxValue, set.bgBase)).toBeGreaterThanOrEqual(3);
      expect(contrast(set.syntaxName, set.bgBase)).toBeGreaterThan(contrast(set.syntaxStructure, set.bgBase));
      expect(contrast(set.syntaxValue, set.bgBase)).toBeGreaterThan(contrast(set.syntaxName, set.bgBase));
    }
  });

  it('keeps the lifted quiet tier a step below body and above ghost', () => {
    for (const set of Object.values(beelineThemes)) {
      const onCanvas = (ink: string) => contrast(ink, set.bgBase);
      expect(onCanvas(set.ledgerBody)).toBeGreaterThan(onCanvas(set.ledgerQuiet));
      expect(onCanvas(set.ledgerQuiet)).toBeGreaterThan(onCanvas(set.ledgerGhost));
    }
  });
});

describe('Borrowing Calm type roles and spacing', () => {
  const role = (fontFamily: string, fontSize: number, lineHeight: number, letterSpacing: number) => ({
    fontFamily,
    fontSize,
    lineHeight,
    letterSpacing,
  });

  it('pins the four sizes and the one mono role', () => {
    expect(typeRoles).toEqual({
      hero: role('SpaceGrotesk-Medium', 22, 32, -0.3),
      body: role('SpaceGrotesk-Regular', 16, 23, 0),
      bodyStrong: role('SpaceGrotesk-SemiBold', 16, 23, 0),
      meta: role('SpaceGrotesk-Regular', 13, 19, 0),
      sectionHead: {
        ...role('SpaceGrotesk-Medium', 10, 15, 2),
        textTransform: 'uppercase',
      },
      machine: role('IBMPlexMono-Regular', 13, 19, 0),
    });
    for (const value of Object.values(typeRoles)) {
      expect(value.lineHeight).toBe(Math.round(value.fontSize * 1.45));
    }
    // Section heads are the only tracked-uppercase style.
    const uppercase = Object.entries(typeRoles).filter(([, value]) => 'textTransform' in value);
    expect(uppercase.map(([name]) => name)).toEqual(['sectionHead']);
  });

  it('pins the spacing scale', () => {
    expect(space).toEqual({ xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 });
    expect(layout).toEqual({ row: 64, sectionGap: 24, screenTop: 24 });
  });

  it('exposes the roles on every theme token set', () => {
    for (const theme of Object.values(beelineThemes)) {
      expect(theme.type).toBe(typeRoles);
      expect(theme.space).toBe(space);
      expect(theme.layout).toBe(layout);
    }
  });
});
