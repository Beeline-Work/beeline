// DRAWER-HISTORY-COMPAT-1: built navigator stand-in for an unidentified web runtime.
// Run from the repository root with --check, or visit /?baseline, /?fixed and /?modern.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const mobile = resolve(import.meta.dirname, '..');
const project = resolve(mobile, '../../.corner-artifacts/drawer-history-compat');
mkdirSync(project, { recursive: true });
const write = (name, content) => writeFileSync(join(project, name), content);
const manifest = JSON.parse(readFileSync(join(mobile, 'package.json'), 'utf8'));
write('package.json', JSON.stringify({ name: 'drawer-history-compat-proof', private: true,
  main: 'index.js', dependencies: manifest.dependencies }));
write('app.json', JSON.stringify({ expo: { name: 'Drawer history proof', slug: 'drawer-history-proof',
  web: { bundler: 'metro', output: 'single' } } }));
try { symlinkSync(join(mobile, 'node_modules'), join(project, 'node_modules'), 'dir'); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
write('babel.config.js', "module.exports = { presets: ['babel-preset-expo'] };\n");
write('metro.config.js', `
  const { getDefaultConfig } = require('expo/metro-config');
  const config = getDefaultConfig(__dirname);
  config.watchFolders = [${JSON.stringify(mobile)}, ${JSON.stringify(resolve(mobile, '../../packages'))}];
  config.resolver.nodeModulesPaths = [${JSON.stringify(join(mobile, 'node_modules'))}, ${JSON.stringify(resolve(mobile, '../../node_modules'))}];
  module.exports = config;
`);
write('index.js', `
  if (location.search !== '?modern') {
    delete Array.prototype.findLast;
    delete Array.prototype.findLastIndex;
  }
  if (location.search !== '?baseline') require(${JSON.stringify(join(mobile, 'sources/polyfills/arrayFindLast'))});
  require('./App');
`);
write('App.js', `
  import React from 'react';
  import { registerRootComponent } from 'expo';
  import { Button, Text, View } from 'react-native';
  import { NavigationContainer } from '@react-navigation/native';
  import { createDrawerNavigator, useDrawerStatus } from '@react-navigation/drawer';
  const Drawer = createDrawerNavigator();
  class Boundary extends React.Component {
    state = { error: null };
    static getDerivedStateFromError(error) { return { error: String(error) }; }
    render() { return this.state.error ? <Text>{this.state.error}</Text> : this.props.children; }
  }
  function Screen({ navigation, route }) {
    const status = useDrawerStatus();
    return <View style={{flex:1,padding:32}}>
      <Text>{route.name + ' drawer ' + status}</Text>
      <Button title="Open drawer" onPress={() => navigation.openDrawer()} />
      <Button title="Go back" onPress={() => navigation.goBack()} />
    </View>;
  }
  function App() {
    return <Boundary><NavigationContainer>
      <Drawer.Navigator backBehavior="fullHistory" screenOptions={{headerShown:false,drawerType:'front'}}
        drawerContent={({navigation}) => <View style={{padding:32}}>
          <Text>Navigation menu</Text>
          <Button title="Visit Settings" onPress={() => navigation.navigate('Settings')} />
          <Button title="Close menu" onPress={() => navigation.closeDrawer()} />
        </View>}>
        <Drawer.Screen name="Home" component={Screen} />
        <Drawer.Screen name="Settings" component={Screen} />
      </Drawer.Navigator>
    </NavigationContainer></Boundary>;
  }
  registerRootComponent(App);
`);

await new Promise((resolveBuild, reject) => {
  const child = spawn(process.execPath, [join(mobile, 'node_modules/expo/bin/cli'), 'export',
    '--platform', 'web', '--max-workers', '2'], {
    cwd: project, stdio: 'inherit', env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' },
  });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolveBuild() : reject(new Error('Expo export failed: ' + code)));
});

const output = join(project, 'dist');
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(output, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(output + '/')) { res.writeHead(403).end(); return; }
  try {
    let content = readFileSync(file);
    if (file.endsWith('.html') && process.argv.includes('--check')) {
      // Chrome virtual timers don't advance compositor transitions reliably.
      content = content.toString() + `<style>* { transition: none !important; animation: none !important; }</style><script>
        addEventListener('load', async () => {
          const pause = () => new Promise(r => setTimeout(r, 400));
          const observed = [];
          const visible = el => {
            const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
            return !el.closest('[aria-hidden="true"]') && style.visibility !== 'hidden' &&
              rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < innerWidth &&
              rect.bottom > 0 && rect.top < innerHeight;
          };
          const check = async text => {
            await pause();
            if (![...document.querySelectorAll('*')].some(el => el.textContent.trim().includes(text) &&
              el.childElementCount === 0 && visible(el))) throw new Error('Expected visible ' + text + ': ' + document.body.innerText);
            observed.push(text);
          };
          const click = label => {
            const button = [...document.querySelectorAll('button,[role="button"]')].find(el =>
              el.innerText.trim().toLowerCase() === label && visible(el));
            if (!button) throw new Error('Missing button: ' + label);
            button.click();
          };
          try {
            if (location.search === '?baseline') await check('history.findLast is not a function');
            else {
              await check('Home drawer closed');
              click('open drawer'); await check('Navigation menu');
              click('close menu'); await check('Home drawer closed');
              click('open drawer'); await check('Navigation menu');
              click('visit settings'); await check('Settings drawer closed');
              click('go back'); await check('Home drawer closed');
            }
            const result = document.createElement('pre'); result.id = 'proof-result';
            result.textContent = JSON.stringify({ pass: true, observed }); document.body.appendChild(result);
          } catch (error) {
            const result = document.createElement('pre'); result.id = 'proof-result';
            result.textContent = JSON.stringify({ pass: false, error: String(error), observed }); document.body.appendChild(result);
          }
        });
      </script>`;
    }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' :
      file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port;
console.log('DRAWER-HISTORY-COMPAT-1 browser proof: ' + url);
if (process.argv.includes('--check')) {
  try {
    for (const mode of ['baseline', 'fixed', 'modern']) {
      const profile = mkdtempSync(join(tmpdir(), 'beeline-drawer-proof-'));
      try {
        const dom = await new Promise((resolveDom, reject) => {
          const child = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', [
            '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
            '--user-data-dir=' + profile, '--dump-dom', '--virtual-time-budget=10000', url + '/?' + mode,
          ], { timeout: 20000 });
          let stdout = '', stderr = '';
          child.stdout.on('data', chunk => { stdout += chunk; });
          child.stderr.on('data', chunk => { stderr += chunk; });
          child.on('error', reject);
          child.on('exit', code => code === 0 ? resolveDom(stdout) : reject(new Error(stderr)));
        });
        const result = dom.match(/<pre id="proof-result">(.*?)<\/pre>/s)?.[1];
        console.log(mode + ': ' + (result || dom));
        if (!result || !JSON.parse(result).pass) throw new Error(mode + ' browser proof failed');
      } finally { rmSync(profile, { recursive: true, force: true }); }
    }
  } finally { server.close(); }
}
