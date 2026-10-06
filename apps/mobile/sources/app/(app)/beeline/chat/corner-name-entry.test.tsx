import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { roomNameEntry } from '@/buzz/room-name';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Mount the shipped field, isolated from the chat screen's network subscriptions.
const source = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('chat.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let field = '';
function find(node: ts.Node) {
  if (ts.isJsxSelfClosingElement(node) && node.attributes.properties.some((attribute) =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'testID' &&
    attribute.initializer && ts.isStringLiteral(attribute.initializer) &&
    attribute.initializer.text === 'rename-corner-input',
  )) field = node.getText(ast);
  ts.forEachChild(node, find);
}
find(ast);
if (!field) throw new Error('corner rename field missing');
const compiled = ts.transpileModule(`const field = ${field};`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
const renderField = new Function(
  'React', 'HullDialogInput', 'CORNER_LABEL', 'renameBusy', 'roomNameEntry',
  'setRenameDraft', 'setRenameError', 'handleRenameRoom', 'renameDraft',
  `${compiled}\nreturn field;`,
);

it('Reproduction name-whitespace: corner rename replaces typed/pasted whitespace and submits the continuous name', () => {
  const submit = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState('ledger');
    return renderField(React, 'TextInput', 'Corner', false, roomNameEntry,
      setDraft, vi.fn(), () => submit(draft), draft);
  }
  let tree: any;
  act(() => { tree = create(<Harness />); });
  const input = () => tree.root.findByType('TextInput');
  act(() => input().props.onChangeText('ledger '));
  expect(input().props.value).toBe('ledger-');
  act(() => input().props.onChangeText('ledger\tdrift\u00a0fix'));
  expect(input().props.value).toBe('ledger-drift-fix');
  expect(input().props.autoCapitalize).toBe('none');
  expect(input().props.autoCorrect).toBe(false);
  act(() => input().props.onSubmitEditing());
  expect(submit).toHaveBeenCalledWith('ledger-drift-fix');
  console.log('Reproduction name-whitespace: corner typed space → ledger-; pasted tab/NBSP → ledger-drift-fix; submitted ledger-drift-fix');
  act(() => tree.unmount());
});
