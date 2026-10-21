import { createServer } from 'node:http';
import { serveRunnableArtifact } from '../apps/server/src/runnable-artifact.ts';
const game = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#14091a;color:#f0f0f3;font:24px sans-serif;margin:24px}canvas{width:100%;height:320px;touch-action:none;background:#291e33}button{font:inherit}</style></head><body><h1>Tap the jellybean</h1><p id="score">Score: 0</p><canvas id="game" width="320" height="320"></canvas><p id="security">Checking isolation…</p><script>let n=0;const c=document.querySelector('canvas'),s=document.querySelector('#score'),x=c.getContext('2d');function draw(){x.clearRect(0,0,320,320);x.fillStyle='#E5A645';x.beginPath();x.ellipse(160,160,45,65,.4,0,7);x.fill()}draw();c.onpointerdown=()=>{s.textContent='Score: '+(++n);draw()};let blocked=0;for(const f of [()=>document.cookie,()=>localStorage.getItem('beeline-session'),()=>parent.document.body]){try{f()}catch{blocked++}}fetch('https://server.usebeeline.app/v1/phone/identity').then(()=>document.querySelector('#security').textContent='FAIL network allowed').catch(()=>document.querySelector('#security').textContent='Storage checks blocked: '+blocked+'; API blocked');</script></body></html>`;
const loop =
  '<!doctype html><meta name="viewport" content="width=device-width"><h1>Runaway game</h1><script>setTimeout(()=>{console.log("RUNNABLE_LOOP_ENTERED");while(true){}},1500)</script>';
createServer((req, res) =>
  serveRunnableArtifact(req, res, 'https://proof.invalid', {
    openRunnableArtifact: async (id) =>
      Buffer.from(
        id.startsWith('4444')
          ? '<h1>Immediate navigation probe</h1><script>console.log("NAVIGATION_ATTEMPT");location.href="https://example.org"</script>'
          : id.startsWith('3333')
            ? '<h1>Navigation probe</h1><script>setTimeout(()=>{console.log("NAVIGATION_ATTEMPT");location.href="https://example.org"},1000)</script>'
            : id.startsWith('2222')
              ? loop
              : game,
      ),
  }),
).listen(18764, '127.0.0.1', () => console.log('fixture 18764'));
