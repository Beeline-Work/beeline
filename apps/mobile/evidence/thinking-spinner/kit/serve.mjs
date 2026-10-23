// Local preview only: forward the existing disposable service with its allowed
// origin. No response data or authentication behavior is mocked.
import {createServer, request} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
createServer((req,res)=>{
 if(req.method==='OPTIONS') {res.writeHead(204,{'access-control-allow-origin':'http://127.0.0.1:18894','access-control-allow-credentials':'true','access-control-allow-methods':'GET, POST, PUT, PATCH, DELETE, OPTIONS','access-control-allow-headers':req.headers['access-control-request-headers']??'content-type,authorization'});res.end();return;}
 const upstream=request({hostname:'127.0.0.1',port:18890,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:18890',origin:'http://127.0.0.1:18892'}},reply=>{res.writeHead(reply.statusCode,{...reply.headers,'access-control-allow-origin':'http://127.0.0.1:18894','access-control-allow-credentials':'true'});reply.pipe(res)});
 upstream.on('error',()=>res.writeHead(502).end());req.pipe(upstream);
}).listen(18895,'127.0.0.1');
const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml','.wasm':'application/wasm','.ttf':'font/ttf','.json':'application/json'};
createServer(async(req,res)=>{try{const root=(await readFile('/tmp/jellybean-spinner/active','utf8')).trim();let p=path.join(root,decodeURIComponent(req.url.split('?')[0]));if(!p.startsWith(root))throw Error('path');try{if((await stat(p)).isDirectory())p=path.join(p,'index.html');await stat(p)}catch{p=path.join(root,'index.html')}res.setHeader('Content-Type',mime[path.extname(p)]??'application/octet-stream');res.end(await readFile(p));}catch{res.writeHead(404).end()}}).listen(18894,'127.0.0.1');
