import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'apps/mobile/transcript-dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/image.png') {
      await new Promise(resolve => setTimeout(resolve, 250));
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1WQAAAAASUVORK5CYII=', 'base64'));
      return;
    }
    const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (file !== root && !file.startsWith(`${root}/`)) { res.writeHead(403).end(); return; }
    const extension = path.extname(file);
    const target = extension ? file : path.join(root, 'index.html');
    res.setHeader('Content-Type', types[path.extname(target)] ?? 'application/octet-stream');
    res.end(await readFile(target));
  } catch { res.writeHead(404).end(); }
}).listen(19882, '127.0.0.1', () => console.log('Transcript fixture web and images: http://127.0.0.1:19882'));
