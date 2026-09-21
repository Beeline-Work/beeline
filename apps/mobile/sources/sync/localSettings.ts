import * as z from 'zod';

export const LocalSettingsSchema = z.object({
    appearance: z.enum(['light', 'dark']),
    commandPaletteEnabled: z.boolean(),
    consoleLoggingEnabled: z.boolean(),
    roomOpenTraceOverlay: z.boolean(),
    uiSize: z.enum(['small', 'medium', 'large']),
    zenMode: z.boolean(),
});

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

export const localSettingsDefaults: LocalSettings = Object.freeze({
    appearance: 'dark',
    commandPaletteEnabled: false,
    consoleLoggingEnabled: false,
    roomOpenTraceOverlay: false,
    uiSize: 'medium',
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
