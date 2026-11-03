import {build} from 'esbuild';
await build({entryPoints:['web/marketing/demo-source.mjs'],outfile:'web/marketing/demo.js',bundle:true,minify:true,format:'esm',target:'es2022',legalComments:'eof'});
