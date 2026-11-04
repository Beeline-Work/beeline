from device import *
label=sys.argv[1]
for mode in ('warm','return','return','warm'):
 token=f'{label}-{mode}-{time.time_ns()%1000000}'
 # Keyboard stays open: prepare text with a fresh accessibility-based input tap.
 tap_id('chat-input');adb('shell','input','keycombination','KEYCODE_CTRL_LEFT','KEYCODE_A');adb('shell','input','keyevent','KEYCODE_DEL');adb('shell','input','text',token);adb('shell','input','keyevent','4');time.sleep(.5)
 if mode=='return':
  adb('shell','input','keyevent','3');time.sleep(.4)
  adb('shell','am','start','-n','app.usebeeline/.MainActivity')
 time.sleep(.25)
 ime=adb('shell','dumpsys','input_method').decode()
 keyboard='mInputShown=true' in ime
 t=int(adb('shell','date','+%s%3N'))
 adb('shell','input','tap',981,1439 if keyboard else 2259)
 print(json.dumps({'token':token,'mode':mode,'tapLowerBound':t}),flush=True)
 time.sleep(3)
snapshot(label+'-sends')
