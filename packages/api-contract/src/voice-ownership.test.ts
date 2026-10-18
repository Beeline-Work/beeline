import {expect,it} from 'vitest';
import {readVoiceOwner,readVoiceOwnershipState,readVoiceJoin} from './voice.js';
const owner={callId:'11111111-1111-4111-8111-111111111111',deviceId:'device',sessionId:'session',epoch:2};
it('validates captured owners and terminal/conflict receipts without guessing missing authority',()=>{
 expect(readVoiceOwner(owner)).toEqual(owner);
 for(const value of [{...owner,epoch:0},{...owner,epoch:1.1},{...owner,deviceId:''},{...owner,callId:'a'.repeat(36)},{...owner,sessionId:undefined}])expect(readVoiceOwner(value)).toBeUndefined();
 expect(readVoiceOwnershipState({state:'elsewhere',owner})).toEqual({state:'elsewhere',owner});
 expect(readVoiceOwnershipState({state:'replaced'})).toEqual({state:'replaced'});
 expect(readVoiceOwnershipState({state:'elsewhere',owner:{}})).toBeUndefined();
 expect(readVoiceOwnershipState({state:'ready'})).toBeUndefined();
});
it('validates ownership fields together while retaining legacy join receipts',()=>{
 const receipt={sessionId:'session',stopToken:'stop',token:'rtc',url:'wss://rtc.example',call:{id:owner.callId,roomId:owner.callId,startedAt:1,participants:[]},agents:[]};
 expect(readVoiceJoin(receipt)).toEqual(receipt);
 expect(readVoiceJoin({...receipt,deviceId:'device',epoch:2})).toMatchObject({deviceId:'device',epoch:2});
 for(const value of [{...receipt,epoch:2},{...receipt,deviceId:'device'},{...receipt,token:null},{...receipt,url:'https://rtc.example'},{...receipt,agents:[{}]}])expect(readVoiceJoin(value)).toBeUndefined();
});
