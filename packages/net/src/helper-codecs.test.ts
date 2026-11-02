import { expect,it } from 'vitest';
import { helperUsageCodecs } from './helper-codecs.js';
it('exports only the exact three helper data-write codecs and rejects route widening',()=>{
  expect(()=>helperUsageCodecs('getDaemonBootstrap' as never)).toThrow('unavailable');
  const params=helperUsageCodecs('postAgentUsage').params;
  expect(()=>params.parse({agentId:'synthetic',usage:{updatedAt:1,windows:[]},arbitrary:true})).toThrow();
  expect(()=>helperUsageCodecs('publishAgentUsageAccount').result.parse({id:'missing-published-account',createdAt:1})).toThrow();
  expect(()=>helperUsageCodecs('attachAgentUsageAccount').result.parse({id:'ok',createdAt:1})).not.toThrow();
});
