let failConnect=0,failRefresh=0,dropWrite=false;let dropSocket,slowConnect=0;
rpc.exports={fault(connect,refresh){failConnect=connect;failRefresh=refresh;return 'armed';},drop(){return dropSocket();},dropwrite(){dropWrite=true;return 'armed';},slow(){slowConnect=16000;return 'armed';}};
Java.perform(function () {
  const WS = Java.use('com.facebook.react.modules.websocket.WebSocketModule');
  dropSocket=()=>new Promise(resolve=>Java.perform(()=>Java.choose('com.facebook.react.modules.websocket.WebSocketModule',{onMatch(module){const map=WS['access$getWebSocketConnections$p'](module);const keys=map.keySet().toArray();for(let i=0;i<keys.length;i++)module.close(1001,'proof transient loss',Number(keys[i].toString()));},onComplete(){resolve('closed');}})));
  const emit = (event, detail) => send(Object.assign({event, at:Date.now()},detail||{}));
  const connect=WS.connect;
  connect.implementation=function(url,protocols,options,id){
    emit('connect',{id:Number(id),live:String(url).includes('/v1/phone/live')});
    if(failConnect>0 && String(url).includes('/v1/phone/live')){failConnect--;emit('injected-connect-failure');this.notifyWebSocketFailed(Number(id),'proof transient upgrade failure');return;}
    if(slowConnect){const ms=slowConnect;slowConnect=0;const owner=Java.retain(this), ps=protocols?Java.retain(protocols):null, opts=options?Java.retain(options):null, u=String(url);emit('injected-slow-handshake',{ms});setTimeout(()=>Java.perform(()=>connect.call(owner,u,ps,opts,id)),ms);return;}
    return connect.call(this,url,protocols,options,id);
  };
  const close=WS.close;
  close.implementation=function(code,reason,id){emit('close-request',{id:Number(id),code:Number(code)});return close.call(this,code,reason,id);};
  const write=WS.send.overload('java.lang.String','double');
  write.implementation=function(value,id){
    try {const f=JSON.parse(String(value));emit('write',{id:Number(id),t:f.t,type:f.type,request:f.id,op:f.op,messageId:f.args&&f.args.messageId});} catch(e){}
    if(dropWrite){try{const f=JSON.parse(String(value));if(f.op==='sendRoomMessage'){dropWrite=false;emit('injected-brief-drop',{request:f.id,messageId:f.args.messageId});this.close(1001,'proof transient loss',id);return;}}catch(e){}}
    return write.call(this,value,id);
  };
  const event=WS.sendEvent;
  event.implementation=function(name,params){
    try {
      const n=String(name), map=params.toHashMap();
      if(n==='websocketMessage') {const f=JSON.parse(String(map.get('data')));emit('read',{t:f.t,type:f.type,request:f.id,ok:f.ok});}
      else emit(n,n==='websocketFailed'?{reason:String(map.get('message')).replace(/bearer\.[A-Za-z0-9._-]+/g,'[redacted]').slice(0,180)}:{});
    }catch(e){emit('parse-error',{error:String(e)});}
    return event.call(this,name,params);
  };
  const Net=Java.use('com.facebook.react.modules.network.NetworkingModule');
  const http=Net.sendRequest;
  http.implementation=function(method,url,id,headers,data,responseType,incremental,timeout,credentials){
    if(String(url).includes('/v1/auth/refresh')){
      emit('refresh');
      if(failRefresh>0){failRefresh--;emit('injected-refresh-failure');
        const a=Java.use('com.facebook.react.bridge.Arguments').createArray();a.pushInt(Number(id));a.pushString('proof transient refresh network failure');
        this.getReactApplicationContext().emitDeviceEvent('didCompleteNetworkResponse',a);return;
      }
    }
    return http.call(this,method,url,id,headers,data,responseType,incremental,timeout,credentials);
  };
  const Activity=Java.use('android.app.Activity');
  const touch=Activity.dispatchTouchEvent;
  touch.implementation=function(e){
    if(e.getAction()===1)emit('touch',{x:e.getRawX(),y:e.getRawY()});
    return touch.call(this,e);
  };
  emit('ready');
});
