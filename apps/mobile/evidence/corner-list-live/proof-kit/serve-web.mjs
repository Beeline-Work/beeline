import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(process.argv[2]);
const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml','.wasm':'application/wasm','.ttf':'font/ttf'};
createServer(async(req,res)=>{try{let p=path.join(root,decodeURIComponent(req.url.split('?')[0]));if(!p.startsWith(root))throw Error('path');try{if((await stat(p)).isDirectory())p=path.join(p,'index.html');await stat(p)}catch{p=path.join(root,'index.html')}res.setHeader('Content-Type',mime[path.extname(p)]??'application/octet-stream');res.end(await readFile(p));}catch{res.writeHead(404).end()}}).listen(9182,'0.0.0.0');
