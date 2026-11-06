import assert from 'node:assert/strict';
import { it } from 'node:test';
import { grandfatherRegistry, judgeUiRegistry, scanUiSource } from './mobile-ui-policy.mjs';

it('allows an exact legacy control move while rejecting copies, style changes and handler changes', () => {
  const source = (owner, color = 'red', handler = 'go') => `
    import { TouchableOpacity, Text } from 'react-native';
    const styles = { button: { backgroundColor: '${color}' } };
    export function ${owner}() { return <TouchableOpacity style={styles.button} onPress={${handler}}><Text>Open</Text></TouchableOpacity>; }
  `;
  const original = scanUiSource(source('Screen'), 'app/old.tsx');
  const base = { ...grandfatherRegistry([original]), sourceControls: original.offences };
  const moved = scanUiSource(source('Child'), 'app/child.tsx');
  const registry = grandfatherRegistry([moved]);
  assert.deepEqual(judgeUiRegistry([moved], registry, base), []);
  const raised = structuredClone(registry);
  raised.legacyControls[moved.file][moved.offences[0].fingerprint] = 2;
  assert.ok(judgeUiRegistry([moved], raised, base).some(error => error.rule === 'grandfather-growth'));
  const copy = scanUiSource(source('Copy'), 'app/copy.tsx');
  assert.ok(judgeUiRegistry([moved, copy], grandfatherRegistry([moved, copy]), base).some(error => error.rule === 'grandfather-growth'));
  for (const changed of [source('Child', 'blue'), source('Child', 'red', 'different')]) {
    const scan = scanUiSource(changed, 'app/child.tsx');
    assert.ok(judgeUiRegistry([scan], grandfatherRegistry([scan]), base).some(error => error.rule === 'grandfather-growth'));
  }
});
