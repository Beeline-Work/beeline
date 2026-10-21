setTimeout(()=>{console.error('CDP timeout');process.exit(1)},8000).unref();
const W=require('ws');
const label=process.argv[2];
const expression=`(()=>{const hook=globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;let found;const visit=f=>{if(!f||found)return;const p=f.memoizedProps;if(p&&(p.testID===${JSON.stringify(label)}||p.accessibilityLabel===${JSON.stringify(label)})&&typeof p.onPress==='function'){found=p;return}visit(f.child);visit(f.sibling)};for(const id of hook.renderers.keys())for(const root of hook.getFiberRoots(id))visit(root.current);if(!found)return 'missing';found.onPress({stopPropagation(){}});return 'pressed'})()`;
fetch('http://127.0.0.1:18888/json/list').then(r=>r.json()).then(([t])=>{const w=new W(t.webSocketDebuggerUrl);w.on('open',()=>w.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression}})));w.on('message',b=>{console.log(b.toString());w.close()})});
