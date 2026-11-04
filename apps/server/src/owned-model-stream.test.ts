import {describe,expect,it} from 'vitest';
import {OwnedModelStream} from './owned-model-stream.js';

describe('owned model terminal stream boundary',()=>{
  it('strips every provider response ID and withholds terminal evidence across fragmented CRLF frames',()=>{
    const stream=new OwnedModelStream();
    expect(stream.push('id: forged\r\ndata: {"id":"forged","choices":[{"delta":{"content":"hi"},')).toEqual([]);
    const first=stream.push('"finish_reason":null}]}\r\n\r\n');
    expect(first.join('')).not.toContain('forged');expect(first.join('')).toContain('hi');
    const tail=stream.push('data: {"id":"another","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    expect(tail.join('')).not.toContain('another');expect(tail.join('')).not.toContain('[DONE]');
    expect(tail.join('')).not.toContain('"finish_reason":"tool_calls"');
    expect(stream.complete()).toBe(true);
    expect(stream.terminal('server-receipt')).toContain('"id":"server-receipt"');
    expect(stream.terminal('server-receipt')).toContain('"finish_reason":"tool_calls"');
  });
  it('rejects EOF without a complete DONE event even after a clean finish chunk',()=>{
    const stream=new OwnedModelStream();stream.push('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
    expect(stream.complete()).toBe(false);expect(()=>stream.terminal('receipt')).toThrow();
    stream.push('data: [DONE]\n');expect(stream.complete()).toBe(false);
  });
  it('preserves actual tool identities and usage while removing only provider completion IDs',()=>{
    const stream=new OwnedModelStream();const output=stream.push('data: {"id":"provider","choices":[{"delta":{"tool_calls":[{"id":"tool-id","function":{"name":"read"}}]}}],"usage":{"prompt_tokens":2}}\n\n');
    expect(output.join('')).toContain('tool-id');expect(output.join('')).toContain('"prompt_tokens":2');expect(output.join('')).not.toContain('provider');
  });
  it('refuses malformed, oversize or post-terminal events without a success delimiter',()=>{
    for(const input of ['data: []\n\n','data: {"error":{}}\n\n','data: {broken}\n\n','data: '+ 'x'.repeat(256*1024),
      'data: [DONE]\n\ndata: {}\n\n'])expect(()=>new OwnedModelStream().push(input)).toThrow();
  });
});
