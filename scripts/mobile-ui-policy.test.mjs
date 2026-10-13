import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import {
  grandfatherRegistry,
  judgeUiRegistry,
  REGISTRY_PATH,
  registryAtRef,
  scanUiSource,
  scanUiTree,
} from './mobile-ui-policy.mjs';

const empty = { version: 1, components: {}, legacyControls: {} };
const scan = (source, file = 'app/screen.tsx') => scanUiSource(source, file);
const rules = (source) => scan(source).offences.map((offence) => offence.rule);

test('existing source tree passes the checked-in registry', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const registry = JSON.parse(
    readFileSync(new URL('../' + REGISTRY_PATH, import.meta.url), 'utf8'),
  );
  assert.deepEqual(judgeUiRegistry(scanUiTree(root), registry), []);
});

test('a new shared button file fails; explicit registry addition admits it', () => {
  const file = 'components/NewButton.tsx';
  const source =
    "import {Pressable,Text} from 'react-native'; export function NewButton(){return <Pressable><Text>Go</Text></Pressable>}";
  const scans = [scan(source, file)];
  assert.deepEqual(
    judgeUiRegistry(scans, empty).map((error) => error.rule),
    ['component-file', 'component-symbol'],
  );
  assert.deepEqual(judgeUiRegistry(scans, { ...empty, components: { [file]: ['NewButton'] } }), []);
});

test('an extra component in an existing file cannot hide behind its registered file', () => {
  const file = 'components/Button.tsx';
  const scans = [
    scan('export function Button(){return <></>} export const NewButton=()=>null;', file),
  ];
  const errors = judgeUiRegistry(scans, { ...empty, components: { [file]: ['Button'] } });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /NewButton/);
});

test('classes, memo, forwardRef, anonymous default and re-exported aliases are inventoried', () => {
  const component = scan(
    `import React from 'react';
    export class ErrorBoundary extends React.Component {render(){return this.props.children}}
    export const Field=React.forwardRef(()=>null);
    export const Action=React.memo(()=>null);
    export {Button as New_Button} from './Button';
    export default ()=>null;`,
    'components/Extra.tsx',
  );
  assert.deepEqual(component.components, [
    'Action',
    'ErrorBoundary',
    'Field',
    'New_Button',
    'default',
  ]);
  assert.ok(
    scan('export * from "./New";', 'components/Index.ts').components.some((name) =>
      name.startsWith('export:*:'),
    ),
  );
});

test('type-only exports and plain constants do not become components', () => {
  assert.deepEqual(
    scan('export type Button={label:string}; export const SIZE=44;', 'components/sizes.ts')
      .components,
    [],
  );
});

test('raw text fields and styled touch controls fail outside shared components', () => {
  assert.deepEqual(
    rules(`import {TextInput, Pressable, TouchableOpacity, Text} from 'react-native';
    const Screen=()=> <><TextInput/><Pressable style={styles.thing}><Text>Confirm</Text></Pressable>
    <TouchableOpacity accessibilityRole="button"><Text>Retry</Text></TouchableOpacity></>;`),
    ['raw-text-input', 'raw-button', 'raw-button'],
  );
});

test('native import aliases, namespace tags and local aliases cannot bypass the guard', () => {
  assert.deepEqual(
    rules(`import {TextInput as Input,Pressable as Tap} from 'react-native';
    import * as RN from 'react-native'; const Entry=Input;
    const Screen=()=> <><Entry/><RN.TextInput/><Tap style={{height:44}}/></>;`),
    ['raw-text-input', 'raw-text-input', 'raw-button'],
  );
});

test('React.createElement controls are held to the same policy as JSX', () => {
  assert.deepEqual(
    rules(`import React from 'react';import {TextInput,Pressable} from 'react-native';
    const Screen=()=>React.createElement(Pressable,{style:{height:44}},React.createElement(TextInput));`),
    ['raw-button', 'raw-text-input'],
  );
});

test('custom row, header and dialog footer styles resolve through aliases', () => {
  const found = rules(`import {View,Text} from 'react-native';
    const layout={row:{flexDirection:'row'},header:{padding:16},dialogFooter:{padding:16}};
    const rowStyle=layout.row;
    function ExampleDialog(){return <><View style={rowStyle}><Text>Row</Text></View>
      <View style={layout.header}><Text>Heading</Text></View>
      <View style={layout.dialogFooter}><Text>Confirm</Text></View></>}`);
  assert.deepEqual(found, ['custom-row', 'custom-header', 'custom-dialog-footer']);
});

test('using shared components and ordinary prose or layout passes', () => {
  assert.deepEqual(
    rules(`import {View,Text} from 'react-native';
    import {Button} from '@/components/buzz/Button';
    import {PageHeader} from '@/components/buzz/PageHeader';
    const Screen=()=> <View style={{flex:1}}><PageHeader title="Settings"/><Text>Copy</Text><Button label="Save"/></View>;`),
    [],
  );
});

test('comments, strings and unrelated components called TextInput are harmless', () => {
  assert.deepEqual(
    rules(`import {TextInput} from 'unrelated';
    // <Pressable style={{height:44}}/>
    const s='<TextInput/>';const Screen=()=> <TextInput/>;`),
    [],
  );
});

test('legacy controls are exact and counted; appending a duplicate or swapping a control fails', () => {
  const source =
    "import {TextInput} from 'react-native'; function Screen(){return <TextInput placeholder='Name'/>}";
  const original = scan(source);
  const registry = grandfatherRegistry([original]);
  assert.deepEqual(judgeUiRegistry([original], registry), []);
  assert.equal(judgeUiRegistry([scan(source.replace("'Name'", "'New'"))], registry).length, 1);
  assert.equal(
    judgeUiRegistry(
      [
        scan(
          source.replace(
            "<TextInput placeholder='Name'/>",
            "<><TextInput placeholder='Name'/><TextInput placeholder='Name'/></>",
          ),
        ),
      ],
      registry,
    ).length,
    1,
  );
});

test('formatting and comments do not consume new legacy exceptions', () => {
  const a =
    "import {TextInput} from 'react-native';const styles={entry:{padding:8}};function Screen(){return <TextInput style={styles.entry}/>;}";
  const b =
    "import { TextInput } from 'react-native';\nconst styles = { entry: { padding: 8 /* padding */ } };\nfunction Screen() { return <TextInput style = {styles.entry} />; }";
  assert.deepEqual(judgeUiRegistry([scan(b)], grandfatherRegistry([scan(a)])), []);
});

test('PRs cannot add or expand grandfather entries in the registry', () => {
  const scans = [scan("import {TextInput} from 'react-native';const Screen=()=> <TextInput/>;")];
  const registry = grandfatherRegistry(scans);
  assert.equal(judgeUiRegistry(scans, registry, empty)[0].rule, 'grandfather-growth');
  assert.deepEqual(judgeUiRegistry([], empty, registry), []);
});

test('malformed source and registry fail closed', () => {
  assert.throws(() => scan('const X = <TextInput', 'app/bad.tsx'));
  assert.throws(() => judgeUiRegistry([], {}), /Invalid UI component registry/);
});

test('extension rules receive the same source context and registry enforcement', () => {
  const rule = {
    id: 'confirm-action',
    check: (c) => (c.primitive === 'Pressable' ? 'Use shared confirmation actions.' : null),
  };
  const result = scanUiSource(
    "import {Pressable} from 'react-native'; const Screen=()=> <Pressable/>;",
    'app/screen.tsx',
    [rule],
  );
  assert.equal(judgeUiRegistry([result], empty)[0].rule, 'confirm-action');
});

test('the required TYPECHECK gate executes the policy and its regression tests on every PR', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8'),
  );
  const job = workflow.jobs.typecheck;
  assert.equal(job.name, 'TYPECHECK');
  const step = job.steps.find((step) => step.name === 'Enforce the shared UI component registry');
  assert.ok(step);
  assert.match(step.run, /mobile-ui-policy.test.mjs/);
  assert.match(step.run, /check-mobile-ui-components.mjs --base/);
  assert.equal(step.env.UI_POLICY_BASE, '${{ github.event.pull_request.base.sha || github.sha }}');
  assert.equal(step.if, undefined);
});

test('spread props cannot hide newly hand-rolled buttons', () => {
  assert.deepEqual(
    rules("import {Pressable} from 'react-native'; const Screen=()=> <Pressable {...props}/>;"),
    ['raw-button'],
  );
});

test('new exported aliases of shared components require registration too', () => {
  const value = scan(
    "import {Button} from './Button'; export const FancyButton=Button;",
    'components/actions.tsx',
  );
  assert.deepEqual(value.components, ['FancyButton']);
});

test('default native namespaces and require bindings are recognized', () => {
  assert.deepEqual(
    rules(`import Native from 'react-native';
    const {TextInput: Field}=require('react-native'); const RN=require('react-native');
    function Screen(){return <><Native.TextInput/><Field/><RN.Pressable style={{height:44}}/></>}`),
    ['raw-text-input', 'raw-text-input', 'raw-button'],
  );
});

test('aliased createElement and React namespaces cannot bypass raw controls', () => {
  assert.deepEqual(
    rules(`import * as R from 'react'; import {createElement as h} from 'react';
    import {TextInput} from 'react-native'; const a=h(TextInput); const b=R.createElement(TextInput);`),
    ['raw-text-input', 'raw-text-input'],
  );
});

test('returning UI cannot hide behind a lower-case or underscored component name', () => {
  const value = scan(
    'export function renderButton(){return <button/>} export const _Button=()=>null;',
    'components/actions.tsx',
  );
  assert.deepEqual(value.components, ['_Button', 'renderButton']);
  assert.equal(judgeUiRegistry([value], { ...empty, components: { [value.file]: [] } }).length, 2);
});
