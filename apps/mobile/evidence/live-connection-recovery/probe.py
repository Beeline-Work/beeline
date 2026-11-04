import frida,sys,json,time,subprocess
from pathlib import Path
root=Path(__file__).parent
out=open(sys.argv[1],'a',buffering=1)
def on_message(m,data):
 row=m.get('payload',m)
 out.write(json.dumps(row)+'\n')
 if row.get('event') == 'ready' or m.get('type')=='error': print(json.dumps(row),flush=True)
d=frida.get_device_manager().add_remote_device('127.0.0.1:28126')
pid=int(subprocess.check_output(['adb','-s','emulator-5626','shell','pidof','app.usebeeline']))
s=d.attach(pid)
script=s.create_script((root/'probe.js').read_text());script.on('message',on_message);script.load()
for line in sys.stdin:
 if line.strip()=='quit':break
 if line.strip()=='fault':print(script.exports_sync.fault(1,1),flush=True)
 if line.strip()=='drop':print(script.exports_sync.drop(),flush=True)
 if line.strip()=='dropwrite':print(script.exports_sync.dropwrite(),flush=True)
 if line.strip()=='slow':print(script.exports_sync.slow(),flush=True)
s.detach()
