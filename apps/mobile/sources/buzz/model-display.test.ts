import { describe, expect, it } from 'vitest';
import { displayModel } from './model-display';
describe('displayModel', () => {
  it.each([
    'Default (recommended)',
    'default',
    'DEFAULT model',
    'provider/Default (recommended)',
    ' default',
  ])('hides the harness placeholder %s', (value) => {
    expect(displayModel(value)).toBe('');
  });
  it.each(['6 Astra', '6.1 Sol', 'deepseek-v4.1-flash', 'model-default-fast'])(
    'preserves the real model %s',
    (value) => {
      expect(displayModel(value)).toBe(value);
      expect(displayModel(`provider/${value}`)).toBe(value);
    },
  );
});
