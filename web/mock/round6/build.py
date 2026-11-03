"""Derive the review mock directly from the production marketing page."""
from pathlib import Path
import re,json,hashlib,base64,urllib.request
here=Path(__file__).resolve().parent
web=here.parents[1]
source=(web/'index.html').read_text()
css=re.search(r'<style>(.*?)</style>',source,re.S).group(1)
css=re.sub(r'^\.track\.corner.*\n','',css,flags=re.M)
head=source[:source.index('<style>')].replace('content="index,follow"','content="noindex,nofollow"')
font_link=re.search(r'<link rel="stylesheet" href="(https://fonts.googleapis.com/[^\"]+)"',head).group(1)
font_path=here/'production-fonts.css'
if not font_path.exists():
    font_css=urllib.request.urlopen(font_link).read().decode()
    def inline(m):
        url=m.group(1); blob=urllib.request.urlopen(url).read(); ext='woff2' if url.endswith('woff2') else 'truetype'
        return 'url(data:font/'+ext+';base64,'+base64.b64encode(blob).decode()+')'
    font_path.write_text('/* Production Google Fonts, packaged unchanged for the review sandbox. */\n'+re.sub(r'url\((https://[^)]+)\)',inline,font_css))
head=re.sub(r'<link rel="preconnect"[^>]+>\s*','',head)
head=re.sub(r'<link rel="stylesheet" href="https://fonts.googleapis.com/[^>]+>','<link rel="stylesheet" href="production-fonts.css">',head)
head=head.replace('one Room where your people and your coding agents talk, hand off work, and ship it.','one Room where your teammates share context and your existing agents keep their sessions, skills and tools.')
node_block=source[source.index('    <div class="node agent"'):source.index('    <div class="screen"')]
nodes=re.findall(r'<div class="node (?:agent|human)".*?<span class="name">.*?</span></div>',node_block,re.S)
assert len(nodes)==6
icons=[re.search(r'<svg.*?</svg>',node,re.S).group() for node in nodes]
icons[2]=(web.parent/'apps/server/assets/mcp/grok-bot.svg').read_text()
hermes=web.parent/'apps/mobile/sources/assets/images/agent-logos/hermes.png'
icons[3]='<img src="data:image/png;base64,'+base64.b64encode(hermes.read_bytes()).decode()+'" alt="">'
names=['Claude Code','Codex','grok bot','Hermes','Alan','Jimmy']
ids=['claude','codex','grok','hermes','alan','jimmy']
node_html=[]
for index,node in enumerate(nodes):
    node=re.sub(r'data-id="[^"]+"','data-id="'+ids[index]+'"',node)
    node=re.sub(r'<span class="name">.*?</span>','<span class="name">'+names[index]+'</span>',node)
    node=re.sub(r'<svg.*?</svg>',lambda m:icons[index],node,count=1,flags=re.S)
    if index==1:node=node.replace('class="node agent"','class="node agent not-joined"')
    node=node.replace('data-x="792"','data-x="1120"').replace('data-x="800"','data-x="1128"').replace('data-my="792"','data-my="600"')
    node_html.append(node)
wordmark=re.search(r'<h1 class="wordmark">.*?</h1>',source,re.S).group()
platforms=[]
for match in re.finditer(r'<a class="platform-tile" data-platform="([^"]+)" href="([^"]+)".*?</a>',source,re.S):
    platforms.append({'id':match.group(1),'href':match.group(2),'icon':re.search(r'<svg.*?</svg>',match.group(),re.S).group()})
labels={'ios':'iOS','android':'Android','macos':'Mac','windows':'Windows','linux':'Linux'}
downloads='<div class="smart-download"><a class="primary-download" data-primary-download href="https://web.usebeeline.app">Download Beeline</a><div class="download-meta"><button type="button" class="other-platforms" aria-expanded="false">Other platforms</button></div><div class="other-platform-list" hidden>'+''.join('<a data-os="'+p['id']+'" href="'+p['href']+'">'+p['icon']+labels[p['id']]+'</a>' for p in platforms)+'</div></div>'
hero_text='<div class="hero-top"><div class="hero-heading">'+wordmark+'<p class="tagline">team messaging for agents and humans</p></div>'+downloads+'</div>'
benefits=(here/'benefits.html').read_text().replace('{{DOWNLOADS}}',downloads)
footer=source[source.index('<footer>'):source.index('</footer>')+len('</footer>')]
footer=re.sub(r'<a href="[^"]+">Join Beeline Community</a><span class="sep">·</span>','',footer)
footer=re.sub(r'href="/([^\"]*)"',r'href="https://usebeeline.app/\1"',footer)
geometry=source[source.index('  const stage=document.getElementById'):source.index('  const SCRIPT =')]
geometry=geometry.replace('WIDE={w:880,h:600,pw:320,ph:600}, TALL={w:380,h:880,pw:300,ph:540}','WIDE={w:1200,h:600,pw:760,ph:600}, TALL={w:380,h:650,pw:300,ph:420}')
geometry=geometry.replace('const s=Math.min(1, wrap.clientWidth/F.w);',"if(F===TALL){stage.classList.add('phone');stage.style.setProperty('--s','1');wrap.style.height='auto';return;} stage.classList.remove('phone'); const available=innerHeight-document.querySelector('.hero-top').offsetHeight-48; const s=Math.min(1,wrap.clientWidth/F.w,Math.max(280,available)/F.h);")
geometry=geometry.replace("const track=document.getElementById('track');",'')
geometry=geometry.replace("geo.push({node:n, path:p, id:n.dataset.id, d:d});","p.dataset.actor=n.dataset.id;\n      geo.push({node:n, path:p, id:n.dataset.id, d:d});")
geometry=geometry.replace("addEventListener('resize',()=>{layout();draw();});","addEventListener('resize',()=>{layout();draw();refreshActivity();if(window.r6Demo)update();});")
geometry=geometry.replace('function draw(){', 'function draw(){if(F===TALL){drawPhone();return;}')
geometry+='\n'+(here/'phone-layout.js').read_text()
module=(web/'desktop-download.mjs').read_text()+'\n'+(here/'downloads.js').read_text()
js='(function(){\n'+geometry+'\n'+(here/'story.js').read_text()+'\n})();\n'
(here/'demo.js').write_text('\n'.join(line.rstrip() for line in js.splitlines())+'\n')
html=head+'<style>\n'+css+'</style><link rel="stylesheet" href="hero-base.css"><link rel="stylesheet" href="demo.css?v=phone-stack-2"></head><body><div class="page"><main>\n'
html+='''<section class="hero fullpage" id="hero"><div class="page-inner">
'''+hero_text+'''<figure class="stage-wrap" aria-label="A shared Beeline Room with Alan, Jimmy and their existing agents"><div class="stage" id="stage">\n<svg class="wires" id="wires" aria-hidden="true"></svg>'''+''.join(node_html)+'''
<aside class="join-terminal" id="join-terminal" aria-label="Codex existing session invitation" hidden><div class="terminal-title"><span>● ● ●</span> Codex · existing session</div><div class="terminal-command"><span>› </span><code id="typed-prompt"></code><i aria-hidden="true"></i></div><div class="terminal-state" id="terminal-state">same session · skills · tools</div></aside>
<div class="screen" id="screen"><aside class="app-sidebar"><div class="workspace-name">● ● ●<strong>Beeline Work</strong><small>Your team workspace</small></div><div class="sidebar-label">ROOMS</div><div class="room-selected"># beeline <span>6</span></div><div class="sidebar-label">PEOPLE + AGENTS</div><div class="sidebar-cast" id="sidebar-cast"></div><div class="sidebar-bottom">Everyone’s in the conversation.</div></aside><div class="track" id="track"><div class="view">
<div class="hdr"><span class="back" aria-hidden="true">‹</span><span class="t"><span class="title"><span class="h">#</span>beeline</span><span class="sub">Beeline-Work/beeline</span><span class="sub" id="member-count">5 members ›</span></span><span class="acts" aria-hidden="true">+ ···</span></div>
<div class="ledger" id="room-ledger" tabindex="0" aria-label="Demo conversation"><div class="message-list" id="messages" role="log" aria-live="off"></div></div>
<div class="live-bar"><span class="o" id="live-status">Alan is typing…</span><span class="demo-label">DEMO</span></div>
<form class="composer" id="composer" aria-label="Try the demo"><span class="p" aria-hidden="true">+</span><input id="message-input" name="message" placeholder="Message #beeline" aria-label="Message #beeline — local demo" autocomplete="off" maxlength="1000"><button type="submit" aria-label="Send local demo message" title="Send local demo message">↑</button></form>
</div></div></div></div><figcaption id="stage-caption" class="sr-only">A scripted local conversation. Type into the composer to try it. Nothing is sent or published.</figcaption></figure>
'''+'</div></section>'+benefits+'''</main>'''+footer+'</div><script type="module">'+module+'</script><script src="demo.js?v=phone-stack-2"></script></body></html>'
assert 'corner' not in html.lower()
(here/'index.html').write_text('\n'.join(line.rstrip() for line in html.splitlines())+'\n')
manifest={'base':'web/index.html','baseSHA256':hashlib.sha256(source.encode()).hexdigest(),'preserved':['production palette and typography','phone-format transcript and connector router','production wordmark and original platform destinations'],'changes':['Option 2 cast and local script','active avatar pulses and connectors','mid-story Codex terminal invitation','typeable composer','two animated full-viewport benefits','detected download CTA','desktop app layout','local response table','scroll snapping and reduced-motion settling']}
(here/'production-source.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Round 6 built from production web/index.html')
