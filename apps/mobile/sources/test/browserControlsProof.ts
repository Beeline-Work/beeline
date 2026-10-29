import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Optional visual capture driver: real viewport and animation frames, including touch media queries. */
export async function captureBrowserControls(options: {
  mobile: string; entry: string; shims: Record<string, string>; width: number; height: number;
  head: string; query: string; screenshotPath: string;
}) {
  const { mobile, shims, width, height } = options;
  const directory = await mkdtemp('/tmp/browser-controls-');
  const driverPath = process.env.BROWSER_CONTROLS_CHROME_DRIVER!;
  const { default: puppeteer } = await import(driverPath);
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    await build({ entryPoints: [options.entry], outfile: path.join(directory, 'bundle.js'), bundle: true,
      platform: 'browser', jsx: 'automatic', mainFields: ['browser', 'module', 'main'],
      resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
      loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env.EXPO_OS': '"web"', __DEV__: 'true', global: 'globalThis' },
      plugins: [{ name: 'browser-controls-fixtures', setup(api) {
        api.onResolve({filter: /.*/}, ({path: requested}) => {
          if(requested in shims) return {path:requested, namespace:'shim'};
          if(requested==='react-native') return {path:path.join(mobile,'node_modules/react-native-web/dist/index.js')};
          if(requested.startsWith('@/')) {
            const candidate=path.join(mobile,'sources',requested.slice(2));
            return {path:['','.web.ts','.web.tsx','.ts','.tsx','.json','/index.ts','/index.tsx'].map(ext=>candidate+ext).find(file=>existsSync(file)&&statSync(file).isFile())!};
          }
        });
        api.onLoad({filter:/.*/,namespace:'shim'},({path:requested})=>({contents:shims[requested],loader:'tsx',resolveDir:mobile}));
      }}],
    });
    await writeFile(path.join(directory,'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}</style>${options.head}<div id="root"></div><pre id="result">PENDING</pre><script src="bundle.js"></script>`);
    const page=await browser.newPage();
    await page.setViewport({width,height,isMobile:width<600,hasTouch:width<600,deviceScaleFactor:1});
    await page.goto(pathToFileURL(path.join(directory,'index.html')).href+options.query);
    await page.waitForFunction(()=>document.getElementById('result')?.textContent!=='PENDING');
    const result=await page.$eval('#result',(el: Element)=>el.textContent);
    await page.screenshot({path:options.screenshotPath});
    return {status:0,stderr:'',result:result as string};
  } finally { await browser.close(); await rm(directory,{recursive:true,force:true}); }
}
