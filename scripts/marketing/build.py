"""Build the approved marketing page from its frozen shell and shared UI export."""
from pathlib import Path
import re,json,hashlib,base64,io,shutil
from fontTools.ttLib import TTFont
from fontTools import subset
root=Path(__file__).resolve().parents[2];dest=root/'web/marketing';dest.mkdir(exist_ok=True)
ui=json.loads((dest/'ui.json').read_text());approved=root/'web/mock/round7';source=(approved/'index.html').read_text()
# Offline font subsets preserve the approved faces; browsers receive WOFF2, never TTF/base64.
fonts=[];seen={};fontdir=dest/'fonts';fontdir.mkdir(exist_ok=True)
def font_asset(blob,family,weight,chars=None):
 key=hashlib.sha256(blob).hexdigest()
 if key not in seen:
  font=TTFont(io.BytesIO(blob));opts=subset.Options();opts.layout_features=['*'];sub=subset.Subsetter(options=opts)
  sub.populate(unicodes=chars or list(range(32,592))+list(range(8192,10240)));sub.subset(font);font.flavor='woff2'
  name=re.sub('[^a-z0-9]+','-',family.lower()).strip('-')+'-'+str(weight)+'.woff2';font.save(fontdir/name);seen[key]=name
 name=seen[key];fonts.append("@font-face{font-family:'"+family+"';font-style:normal;font-weight:"+str(weight)+";font-display:swap;src:url('./fonts/"+name+"') format('woff2')}")
for block in re.findall(r'@font-face\s*\{(.*?)\}',(approved/'production-fonts.css').read_text(),re.S):
 family=re.search(r"font-family: '([^']+)'",block)[1];weight=re.search(r'font-weight: (\d+)',block)[1];blob=base64.b64decode(re.search(r'base64,([^)]*)',block)[1]);font_asset(blob,family,weight)
for family in ['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold','IBMPlexMono-Regular']:
 font_asset((root/'apps/mobile/sources/assets/fonts'/f'{family}.ttf').read_bytes(),family,400)
private={ord(c) for c in json.dumps(ui,ensure_ascii=False) if ord(c)>=0xe000}
font_asset((root/'apps/mobile/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf').read_bytes(),'ionicons',400,private)
(dest/'fonts.css').write_text('\n'.join(fonts)+'\n')
for license in approved.glob('*OFL.txt'):shutil.copyfile(license,dest/license.name)
# The approved CSS is retained; the native stylesheet comes from the shared renderer.
critical=re.search(r'<style>(.*?)</style>',source,re.S)[1]
css=critical+'\n'+(approved/'hero-base.css').read_text()+'\n'+(approved/'demo.css').read_text()+'\n'+(approved/'room.css').read_text()+'\n'+(root/'scripts/marketing/production.css').read_text()
(dest/'site.css').write_text(css)
head=source[:source.index('<style>')].replace('noindex,nofollow','index,follow')
head=re.sub(r'<link rel="stylesheet"[^>]*>','',head)
head+='<link rel="canonical" href="https://usebeeline.app/">\n<link rel="preload" href="/marketing/fonts/bricolage-grotesque-700.woff2" as="font" type="font/woff2" crossorigin>\n<link rel="preload" href="/marketing/fonts/spacegrotesk-regular-400.woff2" as="font" type="font/woff2" crossorigin>\n<link rel="stylesheet" href="/marketing/fonts.css">\n<link rel="stylesheet" href="/marketing/native.css">\n<link rel="stylesheet" href="/marketing/site.css?v=1">\n</head>'
body=source[source.index('<body>'):source.index('<script type="module">')]
body=body.replace('<div id="native-hero" class="native-host"></div>','<div id="native-hero" class="native-host">'+ui['room'].replace('<div class="native-ledger"', '<div class="native-ledger"').replace('aria-label="hero demo conversation"></div>','aria-label="hero demo conversation">'+ui['date']+ui['entries'][0]['html']+ui['spacer']+'</div>')+'</div>')
body=body.replace('<div id="native-sync" class="sync-host"></div>','<div id="native-sync" class="sync-host">'+ui['sync']+'</div>')
body=body.replace('<div class="shared-context-room" id="native-context"></div>','<div class="shared-context-room" id="native-context">'+ui['context']+'</div>')
body=body.replace('<div class="sidebar-cast" id="sidebar-cast"></div>','<div class="sidebar-cast" id="sidebar-cast">'+ui['sidebar']+'</div>')
body=re.sub(r'<div class="node [^"]+".*?<span class="name">.*?</span></div>',lambda m:ui['codexNode'].replace('class="node agent live"','class="node agent not-joined"').replace('class="node agent"','class="node agent not-joined"') if 'data-id="codex"' in m[0] else m[0],body,flags=re.S)
def position_node(m):
 tag=m[0];x=float(re.search(r'data-x="([^"]+)"',tag)[1]);y=float(re.search(r'data-y="([^"]+)"',tag)[1]);mx=float(re.search(r'data-mx="([^"]+)"',tag)[1]);tag=re.sub(r' style="[^"]*"','',tag)
 return tag[:-1]+f' style="--node-x:{x/1200*100}%;--node-y:{y/600*100}%;--phone-x:{mx/380*100}%">'
body=re.sub(r'<div class="node [^"]+"[^>]*>',position_node,body)
body=body.replace('aria-label="A shared Beeline Room with Alan, Jimmy and their existing agents"','aria-labelledby="stage-caption"')
# Static glyphs in the benefit diagrams do not need any runtime to appear.
icons={}
for node in re.findall(r'<div class="node .*?<span class="name">.*?</span></div>',source,re.S):
 id=re.search(r'data-id="([^"]+)"',node)[1];icons[id]=re.search(r'<div class="tile">(.*?)</div>',node,re.S)[1]
icons['codex']=ui['cat']
body=re.sub(r'(<span class="[^"]*agent-icon[^"]*" data-icon="([^"]+)">)</span>',lambda m:(m[1].replace('agent-icon','agent-icon native-codex-mark').replace('data-icon="codex"','data-icon="codex" data-codex-identity="cat"') if m[2]=='codex' else m[1])+icons.get(m[2],'')+'</span>',body)
# These are the five existing production destinations, in both download groups.
body=re.sub(r'data-os="([^"]+)"',r'data-os="\1" data-platform="\1"',body)
# Package the existing Hermes mark as a file rather than repeating base64 in HTML.
def image(m):
 blob=base64.b64decode(m[1]);name='hermes-'+hashlib.sha256(blob).hexdigest()[:10]+'.png';(dest/name).write_bytes(blob);return 'src="/marketing/'+name+'"'
body=re.sub(r'src="data:image/png;base64,([^\"]+)"',image,body)
body=body.replace('outline-style: none;', '')
body=re.sub(r'<div\b[^>]*data-testid="(?:codex-shared-mark|chat-byline-mark)"[^>]*>',lambda m:re.sub(r' aria-label="[^"]*"','',m[0]).replace('<div','<div aria-hidden="true"',1),body)
download_names={'ios':'iOS','android':'Android','macos':'Mac','windows':'Windows','linux':'Linux'}
links=dict(re.findall(r'data-os="([^"]+)" data-platform="[^"]+" href="([^"]+)"',body))
fallback='<noscript><nav class="no-script" aria-label="Download Beeline">'+ ' · '.join('<a href="'+url+'">'+download_names[id]+'</a>' for id,url in links.items())+'</nav></noscript>'
(root/'web/index.html').write_text(head+'\n'+body+'\n<script type="module" src="/marketing/boot.mjs?v=1"></script>\n'+fallback+'\n</body></html>\n')
# Preserve the original connector geometry; it remains a small independent module.
geometry=(approved/'demo.js').read_text().split('// Entirely hand-written')[0].removeprefix('(function(){')
geometry=geometry.replace("addEventListener('resize',()=>{layout();draw();refreshActivity();if(window.r7Demo)update();});", "addEventListener('resize',()=>{layout();draw();refreshActivity();});document.fonts.ready.then(()=>{layout();draw();refreshActivity();});")
geometry+='''\nlet active=[];function refreshActivity(){for(const g of geo){const on=active.includes(g.id);g.node.classList.toggle('live',on);g.path.classList.toggle('hot',on);}for(const e of document.querySelectorAll('.sidebar-person'))e.classList.toggle('active',active.includes(e.dataset.person));}\nreturn {setActive(ids){active=ids;refreshActivity();},setConnected(on){stage.classList.toggle('codex-connected',on);document.querySelector('.node[data-id="codex"]').classList.toggle('not-joined',!on);}};\n'''
(dest/'graph.mjs').write_text('export function initializeGraph(){\n'+geometry+'}\n')
story=(approved/'story.js').read_text();a=story.index('  const entries=');b=story.index('  const query=',a);data=story[a:b]
a=story.index('  const replyTable=');b=story.index('  function clearReplies()',a);data+='\n'+story[a:b]+'\nexport {entries,scenes,responses};\n'
(dest/'story.mjs').write_text(data)
manifest={'approvedMock':'da5eb80dd','sharedComponents':json.loads((approved/'component-sources.json').read_text()),'renderer':'scripts/marketing/export-ui.py','runtime':'dependency-free DOM controller','fontBytes':sum(p.stat().st_size for p in fontdir.glob('*.woff2'))}
(dest/'provenance.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Built production marketing shell; WOFF2 fonts:',manifest['fontBytes'],'bytes')
