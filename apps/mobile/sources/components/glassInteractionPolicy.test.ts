import { describe, expect, it } from 'vitest';
import * as glassPolicy from './glassInteractionPolicy';

describe('native GlassView interaction policy', () => {
    it('keeps native GlassView interaction disabled for both requested states', () => {
        expect(glassPolicy.getNativeGlassInteractivity(true)).toBe(false);
        expect(glassPolicy.getNativeGlassInteractivity(false)).toBe(false);
    });
});
