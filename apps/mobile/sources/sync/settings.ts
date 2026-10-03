import * as z from 'zod';

export const SettingsSchema = z.object({
    userMessageBubbleColor: z.string(),
    preferredLanguage: z.string().nullable(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const settingsDefaults: Settings = Object.freeze({
    userMessageBubbleColor: 'gray',
    preferredLanguage: null,
});

export function settingsParse(settings: unknown): Settings {
    const parsed = SettingsSchema.partial().safeParse(settings);
    return parsed.success ? { ...settingsDefaults, ...parsed.data } : { ...settingsDefaults };
}

export function applySettings(settings: Settings, delta: Partial<Settings>): Settings {
    return { ...settingsDefaults, ...settings, ...delta };
}

export function settingsToSyncPayload(settings: Settings): Partial<Settings> {
    return { ...settings };
}
