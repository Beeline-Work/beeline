import { beelineThemes } from '@/buzz/groknight';

/** Keep isolated screen mocks complete when they override only a few tokens. */
export function completeTestTheme(theme: { buzz?: Record<string, any>; [key: string]: any } = {}) {
  const buzz = theme.buzz ?? {};
  const base = beelineThemes.obsidian;
  return {
    ...theme,
    buzz: {
      ...base,
      ...buzz,
      type: { ...base.type, ...buzz.type },
      space: { ...base.space, ...buzz.space },
      layout: { ...base.layout, ...buzz.layout },
    },
  };
}
