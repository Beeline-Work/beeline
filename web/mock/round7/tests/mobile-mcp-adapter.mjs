// Worktree-local adapter for AXI's upstream emulation failure. Browser operations
// still use chrome-devtools-axi and its official MCP server. Installed tools stay unchanged.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
const cache=path.join(os.homedir(),'.npm','_npx');
const candidates=fs.existsSync(cache)?fs.readdirSync(cache).map(name=>path.join(cache,name,'node_modules','chrome-devtools-mcp')).filter(root=>fs.existsSync(path.join(root,'build/src/McpPage.js'))).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs):[];
const upstream=process.env.CHROME_DEVTOOLS_AXI_UPSTREAM_MCP_ROOT||candidates[0];
if(!upstream)throw new Error('Set CHROME_DEVTOOLS_AXI_UPSTREAM_MCP_ROOT to the installed chrome-devtools-mcp package');
const {McpPage}=await import(pathToFileURL(path.join(upstream,'build/src/McpPage.js')).href);
McpPage.prototype.emulate=async function(options){
 const session=await this.pptrPage.createCDPSession();
 const v=options.viewport;
 if(v){await session.send('Emulation.setDeviceMetricsOverride',{width:v.width,height:v.height,deviceScaleFactor:v.deviceScaleFactor??1,mobile:!!v.isMobile,screenWidth:v.width,screenHeight:v.height,screenOrientation:{type:'portraitPrimary',angle:0}});await session.send('Emulation.setTouchEmulationEnabled',{enabled:!!v.hasTouch,maxTouchPoints:5});}
 if(options.userAgent)await session.send('Emulation.setUserAgentOverride',{userAgent:options.userAgent,platform:'Android'});
 // A tall browser toolbar reserves 112 CSS px. This changes actual 100svh,
 // while keeping the large viewport/innerHeight, reproducing browser bars.
 await session.send('Emulation.setSmallViewportHeightDifferenceOverride',{difference:112});
 if(options.prefersReducedMotion)await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:options.prefersReducedMotion}]});
 this.emulationSettings={viewport:v,userAgent:options.userAgent};
};
await import(pathToFileURL(path.join(upstream,'build/src/bin/chrome-devtools-mcp.js')).href);
