import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const mobile = resolve(import.meta.dirname, '..');
const babel = require('@babel/core');
const inlineRequires = require('metro-transform-plugins').inlineRequiresPlugin;

function transformEntry() {
  const filename = resolve(mobile, 'index.ts');
  const compiled = babel.transformSync(readFileSync(filename, 'utf8'), {
    filename, cwd: mobile,
    caller: { name: 'metro', platform: 'android', isDev: false, supportsStaticESM: false },
  });
  return babel.transformSync(compiled.code, {
    configFile: false, babelrc: false, plugins: [inlineRequires],
  }).code;
}

describe('shipped Android theme startup', () => {
  it('keeps the shared entry configuration eager before Router and task installation', () => {
    const events: string[] = [];
    let selected = false;
    runInNewContext(transformEntry(), { require: (id: string) => {
      if (id.startsWith('@babel/runtime/')) return require(id);
      events.push(id);
      if (id === './sources/unistyles') selected = true;
      if (id === 'expo-router/entry') expect(selected).toBe(true);
      if (id.endsWith('notification-action-runtime')) return { installNotificationActions: () => expect(selected).toBe(true) };
      if (id.endsWith('read-clear-runtime')) return { installReadClearTask: () => expect(selected).toBe(true) };
      return {};
    } });
    expect(events).toContain('./sources/unistyles');
    expect(events).toContain('expo-router/entry');
  });
});
