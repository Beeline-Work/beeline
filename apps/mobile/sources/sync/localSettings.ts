import * as z from 'zod';

export const LocalSettingsSchema = z.object({
    commandPaletteEnabled: z.boolean(),
    consoleLoggingEnabled: z.boolean(),
    zenMode: z.boolean(),
});

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

export const localSettingsDefaults: LocalSettings = Object.freeze({
    commandPaletteEnabled: false,
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
