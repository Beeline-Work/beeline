import { it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectCornerMachineSource, checkCornerMachine } from './corner-machine-boundary.mjs';

it('freezes the real corner tree to one state/wake owner', () => {
  assert.deepEqual(checkCornerMachine(process.cwd()), []);
});
it('rejects planted state and wake backdoors, including a renamed queue import', () => {
  for (const source of [
    "db.query('UPDATE rooms SET archived_at=now() WHERE id=$1')",
    'db.query(`UPDATE corner_facts SET machine=$1 WHERE corner_id=$2`)',
    "db.query('INSERT INTO corner_facts(corner_id,machine) VALUES($1,$2)')",
    "createAgentCommand(db,{roomId:cornerId,reason:'corner_check'})",
    "import { createAgentCommand as wake } from './agent-command.js'; wake(db,{reason:'corner_review_dispatch'})",
    "import * as commands from './agent-command.js'; commands.insertAgentCommand(db,input)",
    "export { insertAgentCommand as wake } from './agent-command.js'",
    "import { insertAgentCommand as wake } from './agent-command.js'; wake(db,input)",
  ]) {
    assert.ok(
      inspectCornerMachineSource('apps/server/src/planted-backdoor.ts', source).length,
      source,
    );
    assert.deepEqual(inspectCornerMachineSource('apps/server/src/corner-lifecycle.ts', source), []);
  }
});
