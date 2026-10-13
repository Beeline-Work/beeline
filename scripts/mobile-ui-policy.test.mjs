import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
const rules = (source) =>
  scan(source)
    .offences.filter((offence) => !offence.strict)
    .map((offence) => offence.rule);

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
    "import {Pressable} from 'react-native'; function Screen(){return <Pressable accessibilityRole='button' accessibilityLabel='Name'/>}";
  const original = scan(source);
  const registry = grandfatherRegistry([original]);
  assert.deepEqual(judgeUiRegistry([original], registry), []);
  assert.equal(judgeUiRegistry([scan(source.replace("'Name'", "'New'"))], registry).length, 1);
  assert.equal(
    judgeUiRegistry(
      [
        scan(
          source.replace(
            "<Pressable accessibilityRole='button' accessibilityLabel='Name'/>",
            "<><Pressable accessibilityRole='button' accessibilityLabel='Name'/><Pressable accessibilityRole='button' accessibilityLabel='Name'/></>",
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
    "import {Pressable} from 'react-native';const styles={entry:{padding:8}};function Screen(){return <Pressable style={styles.entry}/>;}";
  const b =
    "import { Pressable } from 'react-native';\nconst styles = { entry: { padding: 8 /* padding */ } };\nfunction Screen() { return <Pressable style = {styles.entry} />; }";
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

test('generated, vendored and module-extension UI sources cannot evade registration', () => {
  const scratch = fileURLToPath(new URL('../.scratch/ui-policy/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, 'source-scope-'));
  try {
    const sources = path.join(root, 'apps/mobile/sources');
    for (const [file, source] of [
      ['components/generated/NewButton.gen.tsx', 'export const NewButton=()=>null;'],
      ['components/vendor/NewControl.mjs', 'export function NewControl(){return null}'],
      [
        'app/input.gen.tsx',
        "import {TextInput} from 'react-native'; export default ()=> <TextInput/>;",
      ],
      ['components/Ignore.test.tsx', 'export const TestFixture=()=>null;'],
    ]) {
      const target = path.join(sources, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    const scans = scanUiTree(root);
    assert.equal(scans.length, 3);
    const errors = judgeUiRegistry(scans, empty);
    assert.equal(errors.filter((error) => error.rule === 'component-file').length, 2);
    assert.equal(errors.filter((error) => error.rule === 'component-symbol').length, 2);
    assert.equal(errors.filter((error) => error.rule === 'raw-text-input').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy shell admits migrated children but rejects new or changed layouts', () => {
  const original =
    "import {View,TextInput} from 'react-native'; const styles={row:{flexDirection:'row',gap:8}}; function Screen(){return <View style={styles.row}><TextInput/></View>}";
  const baseline = grandfatherRegistry([scan(original)]);
  const migrated = original.replace('<TextInput/>', '<HullDialogInput/>');
  assert.deepEqual(judgeUiRegistry([scan(migrated)], baseline, baseline), []);
  assert.ok(
    judgeUiRegistry([scan(migrated.replace('gap:8', 'gap:9'))], baseline, baseline).some(
      (error) => error.rule === 'custom-row',
    ),
  );
  assert.ok(
    judgeUiRegistry(
      [
        scan(
          migrated
            .replace('return <View', 'return <><View')
            .replace('</View>', '</View><View style={styles.row}/></>'),
        ),
      ],
      baseline,
      baseline,
    ).some((error) => error.rule === 'custom-row'),
  );
  assert.ok(
    judgeUiRegistry([scan(original)], baseline, baseline).some(
      (error) => error.rule === 'aligned-text-field',
    ),
  );
});

test('registered component and grandfathering cannot authorize custom decisions or retries', () => {
  const file = 'components/LegacyDialog.tsx';
  for (const body of [
    '<><Tap onPress={cancel}><Text>Cancel</Text></Tap><Tap onPress={save}><Text>Save</Text></Tap></>',
    '<Tap onPress={retry}><Text>Retry</Text></Tap>',
    '<Text onPress={retry}>{error} · Retry</Text>',
    'React.createElement(Tap,{onPress:retry},"Retry")',
  ]) {
    const result = scan(
      "import React from 'react';import {Pressable as Tap,Text} from 'react-native'; export function LegacyDialog(){return " +
        body +
        '}',
      file,
    );
    const registry = grandfatherRegistry([result]);
    assert.ok(
      judgeUiRegistry([result], registry).some((error) => error.rule === 'aligned-decision-retry'),
    );
  }
  const shared = scan(
    `import {Button} from './Button';import {HullDialogActions} from './HullDialog'; export function LegacyDialog(){return <><HullDialogActions actions={actions}/><Button label="Retry"/></>}`,
    file,
  );
  assert.deepEqual(judgeUiRegistry([shared], grandfatherRegistry([shared])), []);
});

test('specialized fields have exact file and owner authority', () => {
  for (const [file, owner] of [
    ['components/buzz/HullDialog.tsx', 'HullDialogInput'],
    ['components/buzz/ConversationComposer.tsx', 'ConversationComposerContent'],
    ['components/CommandPalette/CommandPaletteInput.tsx', 'CommandPaletteInput'],
  ]) {
    const source = `import {TextInput as Input} from 'react-native'; export function ${owner}(){return <Input/>}`;
    assert.ok(!scan(source, file).offences.some((error) => error.strict));
    assert.ok(
      scan(source, 'components/FakeField.tsx').offences.some(
        (error) => error.rule === 'aligned-text-field',
      ),
    );
    assert.ok(
      scan(source.replace(owner, 'NewField'), file).offences.some(
        (error) => error.rule === 'aligned-text-field',
      ),
    );
  }
});

test('createElement layouts also fingerprint only their props and style', () => {
  const original = `import React from 'react';import {View,TextInput} from 'react-native';
    const Screen=()=>React.createElement(View,{style:{flexDirection:'row',gap:8}},React.createElement(TextInput));`;
  const baseline = grandfatherRegistry([scan(original)]);
  const migrated = original.replace(
    'React.createElement(TextInput)',
    'React.createElement(HullDialogInput)',
  );
  assert.deepEqual(judgeUiRegistry([scan(migrated)], baseline, baseline), []);
  assert.ok(
    judgeUiRegistry([scan(migrated.replace('gap:8', 'gap:16'))], baseline, baseline).some(
      (e) => e.rule === 'custom-row',
    ),
  );
});
