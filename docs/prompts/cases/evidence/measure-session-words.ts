import {assembleSessionPrompt} from '../../../../apps/body/src/prompt-assembly.js';
for (const surface of ['room','dm','code-corner','repo-less-corner'] as const) {
const p=assembleSessionPrompt({surface,agentName:'Bee',agentCommand:'claude-agent-acp',soul:{name:'Bee',instructions:'Be concise.'},machineHost:{hostname:'squire'},worktree:{featureBranch:'feature/test',targetBranch:'main'},cornerPrepareScript:true,squireAvailable:true});
console.log(surface,(p.systemPrompt||p.turnPrefix).trim().split(/\s+/).length);
}
