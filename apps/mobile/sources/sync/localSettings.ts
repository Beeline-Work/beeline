import * as z from 'zod';

export const THEME_PREFERENCES = ['obsidian', 'editorial', 'ledger'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

const ThemePreferenceSchema = z.preprocess(
    (value) => value === 'light' || value === 'dark' || value === 'adaptive' ? 'obsidian' : value,
    z.enum(THEME_PREFERENCES),
);

export const LocalSettingsSchema = z.object({
    commandPaletteEnabled: z.boolean(),
    themePreference: ThemePreferenceSchema,
    consoleLoggingEnabled: z.boolean(),
    zenMode: z.boolean(),
});

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

export const localSettingsDefaults: LocalSettings = Object.freeze({
    commandPaletteEnabled: false,
    themePreference: 'obsidian',
    consoleLoggingEnabled: false,
    zenMode: false,
});

export function localSettingsParse(settings: unknown): LocalSettings {
    const parsed = LocalSettingsSchema.partial().safeParse(settings);
    return parsed.success ? { ...localSettingsDefaults, ...parsed.data } : { ...localSettingsDefaults };
}

export function applyLocalSettings(
    settings: LocalSettings,
    delta: Partial<LocalSettings>,
): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
