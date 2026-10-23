import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const mobile = resolve(__dirname, '../..');
const polyfill = buildSync({
  entryPoints: [resolve(__dirname, 'arrayFindLast.ts')],
  bundle: true,
  write: false,
  platform: 'browser',
}).outputFiles[0].text;
// Use the installed dependency entrypoints, including the function in Sentry.
const navigation = buildSync({
  stdin: {
    contents: `
      export { getDrawerStatusFromState } from './node_modules/@react-navigation/drawer/lib/module/utils/getDrawerStatusFromState.js';
      export { DrawerRouter, DrawerActions } from '@react-navigation/routers';
    `,
    resolveDir: mobile,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'navigation',
}).outputFiles[0].text;

function runtime(missing: string[] = []) {
  const context = createContext({});
  runInContext(`
    const originalFindLast = Array.prototype.findLast;
    const originalFindLastIndex = Array.prototype.findLastIndex;
    ${missing.map(name => `delete Array.prototype.${name};`).join('\n')}
  `, context);
  runInContext(navigation, context);
  return context;
}

describe('drawer history on runtimes without ES2023 array search', () => {
  it('reproduces DRAWER-HISTORY-COMPAT-1 before bootstrap', () => {
    const context = runtime(['findLast', 'findLastIndex']);
    expect(() => runInContext(`navigation.getDrawerStatusFromState({ history: [] })`, context))
      .toThrow('findLast is not a function');
  });

  it.each([[], ['findLast'], ['findLastIndex'], ['findLast', 'findLastIndex']])(
    'keeps drawer open/close, route changes and back navigation working: missing %j',
    (...missing) => {
      const context = runtime(missing);
      runInContext(polyfill, context);
      const result = runInContext(`
        const { DrawerRouter, DrawerActions, getDrawerStatusFromState: status } = navigation;
        const router = DrawerRouter({ backBehavior: 'fullHistory' });
        const options = { routeNames: ['Home', 'Settings'], routeParamList: {}, routeGetIdList: {} };
        let state = router.getInitialState(options);
        const observed = [[state.routes[state.index].name, status(state)]];
        for (const action of [DrawerActions.openDrawer(), DrawerActions.closeDrawer(),
          DrawerActions.openDrawer(), DrawerActions.jumpTo('Settings'), { type: 'GO_BACK' }]) {
          const previous = state;
          const history = JSON.stringify(state.history);
          Object.freeze(state.history);
          state = router.getStateForAction(state, action, options);
          if (JSON.stringify(previous.history) !== history) throw new Error('History mutated');
          observed.push([state.routes[state.index].name, status(state)]);
        }
        JSON.stringify(observed);
      `, context);
      expect(JSON.parse(result)).toEqual([
        ['Home', 'closed'], ['Home', 'open'], ['Home', 'closed'],
        ['Home', 'open'], ['Settings', 'closed'], ['Home', 'closed'],
      ]);
    },
  );

  it('uses the last drawer entry without changing history and preserves defaults', () => {
    const context = runtime(['findLast', 'findLastIndex']);
    runInContext(polyfill, context);
    expect(runInContext(`
      const history = Object.freeze([
        { type: 'drawer', status: 'closed' }, { type: 'route', key: 'home' },
        { type: 'drawer', status: 'open' }, { type: 'route', key: 'settings' },
      ]);
      const status = navigation.getDrawerStatusFromState;
      JSON.stringify([status({ history }), status({ history: [], default: 'open' }),
        status({ history: [] }), history[0].status, history[2].status]);
    `, context)).toBe('["open","open","closed","closed","open"]');
    expect(() => runInContext('navigation.getDrawerStatusFromState({})', context))
      .toThrow("Couldn't find the drawer status");
  });

  it('preserves existing runtime implementations', () => {
    const context = runtime();
    runInContext(polyfill, context);
    expect(runInContext(`Array.prototype.findLast === originalFindLast &&
      Array.prototype.findLastIndex === originalFindLastIndex`, context)).toBe(true);
  });

  it('loads compatibility before Sentry, app and router imports', () => {
    const entry = readFileSync(resolve(mobile, 'index.ts'), 'utf8');
    const imports = [...entry.matchAll(/^import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/gm)]
      .map(match => match[1]);
    expect(imports.slice(0, 3)).toEqual([
      'react-native-get-random-values', './sources/polyfills/arrayFindLast', './sources/buzz/sentry',
    ]);
    expect(imports.indexOf('expo-router/entry')).toBeGreaterThan(1);
  });
});
