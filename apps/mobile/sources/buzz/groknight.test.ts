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
    // Obsidian Refined is the only shipped visual language.
    expect(Object.keys(beelineThemes)).toEqual(['obsidian']);
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
  it('sets the app-wide background to the Speakeasy brand canvas ', () => {
    for (const theme of Object.values(beelineThemes)) {
      expect(theme.bgVoid).toBe('#14091A');
      expect(theme.bgTerminal).toBe('#14091A');
      expect(theme.bgBase).toBe('#14091A');
      expect(theme.avatarGround).toBe('#14091A');
    }
  });

  it('keeps every elevation stop at or above the canvas, in ladder order', () => {
    // Luminance proxy: the green channel dominates perceived brightness here
    // and every stop shares a near-identical hue direction, so ordering on it
    // is a faithful check that no stop was pushed BELOW its canvas.
    const lum = (hex: string) => {
      const value = hex.replace('#', '');
      const r = parseInt(value.slice(0, 2), 16);
      const g = parseInt(value.slice(2, 4), 16);
      const b = parseInt(value.slice(4, 6), 16);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const theme of Object.values(beelineThemes)) {
      const canvas = lum(theme.bgBase);
      expect(lum(theme.bgRaised)).toBeGreaterThanOrEqual(canvas);
      expect(lum(theme.bgHighlight)).toBeGreaterThan(canvas);
      // Ledger deliberately shares one stop for highlight and hover.
      expect(lum(theme.bgHover)).toBeGreaterThanOrEqual(lum(theme.bgHighlight));
      expect(lum(theme.bgPressed)).toBeGreaterThan(lum(theme.bgHighlight));
      expect(lum(theme.bgTexturePeak)).toBeGreaterThan(lum(theme.bgPressed));
      // The unread-row ground lift sits exactly one step above the canvas —
      // an area cue for unread rows that must never outrank selection
      // (bgHighlight) or hover.
      expect(lum(theme.bgUnread)).toBeGreaterThan(canvas);
      expect(lum(theme.bgUnread)).toBeLessThan(lum(theme.bgHighlight));
      // Hairlines must stay visible against both the canvas and raised surfaces.
      expect(lum(theme.border)).toBeGreaterThan(canvas);
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
