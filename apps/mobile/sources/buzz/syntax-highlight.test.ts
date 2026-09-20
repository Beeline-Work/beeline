import { describe, expect, it } from 'vitest';
import { flattenTokens, tokenizeCode } from './syntax-highlight';

describe('JSON token roles', () => {
  it.each(['\n', '\r\n', ' \n\n\t'])('recognizes keys across %j whitespace', (whitespace) => {
    const code = `{ "key"${whitespace}: "value" }\n`;
    const lines = tokenizeCode(code, 'json');

    expect(JSON.parse(code)).toEqual({ key: 'value' });
    expect(lines.flat()).toContainEqual({ token: 'name', text: '"key"' });
    expect(lines.flat()).toContainEqual({ token: 'value', text: '"value"' });
    expect(lines.map((line) => line.map((span) => span.text).join(''))).toEqual(code.split('\n'));
    expect(lines.at(-1)).toEqual([]);
    expect(flattenTokens(lines)).toBe(code);
  });

  it.each(['-2.5e-7', '-0', '-42', '0.125', '2e10', '2E+10', '-0.5E-2'])(
    'keeps JSON number %s in one value span',
    (number) => {
      const code = `{ "number": ${number} }`;
      const lines = tokenizeCode(code, 'json');

      expect(JSON.parse(code).number).toBe(Number(number));
      expect(lines.flat().filter((span) => span.token === 'value')).toEqual([
        { token: 'value', text: number },
      ]);
      expect(flattenTokens(lines)).toBe(code);
    },
  );

  it('keeps leading indentation on each JSON line', () => {
    const code = `{
  "providers": {
    "milo": {
      "name": "Milo"
    }
  }
}`;
    const lines = tokenizeCode(code, 'json');

    expect(flattenTokens(lines)).toBe(code);
    expect(lines.map((line) => line.map((span) => span.text).join(''))).toEqual(code.split('\n'));
    expect(lines[1]?.[0]).toEqual({ token: 'plain', text: '  ' });
    expect(lines[2]?.[0]).toEqual({ token: 'plain', text: '    ' });
    expect(lines[3]?.[0]).toEqual({ token: 'plain', text: '      ' });
  });
});
