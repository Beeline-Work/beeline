import json,time,re,subprocess,io,csv
from phone_fixture import Fixture,P,api,adb,sql,OTA
from native_ui import wait_room,type_text,tap,capture,clear_draft,editor_ready,focus,screen,normalized
rooms=json.loads((P/'head3a-functional-rooms.json').read_text());source=rooms['empty'];primary=json.loads((P/'room.json').read_text());token='failureproofBeta';other='unrelatedproofBeta';f=Fixture('head3a-enqueue-fault');report={'sourceHead':'3a77888f6b99465e9156efc237cfab7d5a5167e4','fault':'Reject one deps.save(records) containing failureproofBeta; hold only unrelatedproofBeta transport until a disarmed process restart; product handler and queue logic unchanged.'}
def arm(enabled):
 row=sql("SELECT manifest FROM updates WHERE hex(id)='"+OTA+"'")[0];manifest=json.loads(row['manifest']);manifest['extra']['expoClient']['extra']['app']['nativeEnqueueFault']=enabled;sql("UPDATE updates SET manifest='"+json.dumps(manifest).replace("'","''")+"' WHERE hex(id)='"+OTA+"'")
def ids(text):
 view=api('/v1/phone/rooms/'+source['roomId']);assert view['room']['workspaceId']==source['workspaceId'];return[m['id']for m in view['messages']if m['text']==text]
def save():(f.out/'results.json').write_text(json.dumps(report,indent=2))
def dismiss_error():
 image=screen();out=io.BytesIO();image.save(out,format='PNG');raw=subprocess.run(['tesseract','stdin','stdout','--psm','6','tsv'],input=out.getvalue(),capture_output=True,check=True).stdout.decode();words=list(csv.DictReader(io.StringIO(raw),delimiter='\t'));text=' '.join(w['text']or''for w in words)
 if normalized('Could not prepare message')in normalized(text):
  ok=[w for w in words if(w['text']or'').strip().lower()in['ok','okay']];assert len(ok)==1,text;word=ok[0];x=int(word['left'])+int(word['width'])//2;y=int(word['top'])+int(word['height'])//2;tap(x,y);time.sleep(.5);return{'x':x,'y':y,'title':'Could not prepare message'}
 return None
try:
 assert not ids(token)and not ids(other);report['bundleSha256']=f.install(next((P/'fault3a-export/_expo/static/js/android').glob('*.hbc')),'enqueue-fault-083',report['sourceHead']);arm(True);f.open(source);wait_room('latency-empty');clear_draft();type_text(other);report['unrelatedTap']=capture(f.out,'unrelated-held',lambda:tap());editor_ready();assert not ids(other);f.screenshot('unrelated-queued');report['unrelatedHeldBeforeFault']=True
 type_text(token);report['failureTap']=capture(f.out,'storage-failure',lambda:tap());f.screenshot('failed-storage-draft');pid=adb('shell','pidof app.usebeeline').strip();logs=adb('logcat','-d','--pid='+pid,'-s','ReactNativeJS:W','*:S');filtered=[line for line in logs.splitlines()if'[NATIVE_ENQUEUE_FAULT]'in line];assert filtered,'Controlled durable-save failure did not fire';report['injectedFailedIds']=re.findall(r'\b[0-9a-f]{64}\b','\n'.join(filtered));(f.out/'fault-log.txt').write_text('\n'.join(filtered)+'\n');report['canonicalAfterFailure']=ids(token);assert not report['canonicalAfterFailure'];report['dismissedError']=dismiss_error();focus();editor_ready(token);report['draftRetained']=True;f.screenshot('failure-dismissed-draft');save()
 report['retryTap']=capture(f.out,'storage-retry',lambda:tap());editor_ready();f.screenshot('after-retry');report['canonicalAfterRetry']=ids(token);report['unrelatedStillQueuedAfterRetry']=not ids(other);assert len(report['canonicalAfterRetry'])==1 and report['unrelatedStillQueuedAfterRetry'];save()
 arm(False);report['faultDisarmedBeforeRestart']=True;adb('shell','am force-stop app.usebeeline');f.open(source);wait_room('latency-empty');time.sleep(3);f.screenshot('after-restart');report['canonicalAfterRestart']=ids(token);report['unrelatedAfterRestart']=ids(other);report['passed']=len(report['canonicalAfterRestart'])==1 and len(report['unrelatedAfterRestart'])==1 and not(set(report['injectedFailedIds'])&set(report['canonicalAfterRestart']));save();print(json.dumps(report,indent=2),flush=True)
finally:f.restore(primary)
