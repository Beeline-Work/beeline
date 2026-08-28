import { describe, expect, it } from 'vitest';
import {
    applySettings,
    settingsDefaults,
    settingsParse,
    settingsToSyncPayload,
    type Settings,
} from './settings';

describe('retained mobile settings', () => {
    it('defaults to the Beeline chat appearance and device language', () => {
        expect(settingsDefaults).toEqual({
            userMessageBubbleColor: 'gray',
            preferredLanguage: null,
        });
    });

    it('loads only the settings still consumed by Beeline screens', () => {
        expect(settingsParse({
            userMessageBubbleColor: 'green',
            preferredLanguage: 'ja',
            viewInline: true,
            voiceCustomAgentId: 'retired',
        })).toEqual({
            userMessageBubbleColor: 'green',
            preferredLanguage: 'ja',
        });
    });

    it('falls back atomically when a retained value has the wrong type', () => {
        expect(settingsParse({ preferredLanguage: 42 })).toEqual(settingsDefaults);
    });

    it('applies local appearance changes without restoring removed fields', () => {
        const current: Settings = { ...settingsDefaults };
        expect(applySettings(current, { preferredLanguage: 'es' })).toEqual({
            userMessageBubbleColor: 'gray',
            preferredLanguage: 'es',
        });
    });

    it('persists only the retained closed settings family', () => {
        expect(settingsToSyncPayload({
            ...settingsDefaults,
            userMessageBubbleColor: 'purple',
        })).toEqual({
            userMessageBubbleColor: 'purple',
            preferredLanguage: null,
        });
    });
});
