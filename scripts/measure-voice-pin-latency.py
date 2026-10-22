import json, statistics, sys, time, urllib.request
mode=sys.argv[1]
def req(path, body=None):
    r=urllib.request.Request('http://127.0.0.1:18097'+path,data=None if body is None else json.dumps(body).encode(),headers={'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r,timeout=30))
values=[]
for i in range(12):
    before=len([s for s in req('/result')['signals'] if s.get('type')=='latency'])
    req('/say',{'text':'Ruby ready?','human':'partner','speechMs':300})
    for j in range(100):
        signals=[s for s in req('/result')['signals'] if s.get('type')=='latency']
        if len(signals)>before: break
        time.sleep(.02)
    assert len(signals)>before
    if i>=2: values.append(signals[-1]['firstAudioMs'])
    time.sleep(.5)
record={'mode':mode,'prompt':'Ruby ready?','samplesMs':values,'medianMs':statistics.median(values),'warmupTurns':2,'path':'HTTP utterance -> production runtime -> disposable PGlite -> controlled provider SSE/PCM -> native LiveKit captureFrame -> native RTC latency signal; excludes live model/network and phone speaker latency'}
open('docs/voice-mode-proof/pinned-agent/latency-'+mode+'.json','w').write(json.dumps(record,indent=2)+'\n')
print(json.dumps(record))
