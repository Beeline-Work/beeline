import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, TouchableOpacity, View } from 'react-native';
import { NewCornerDialog } from '../sources/components/buzz/NewCornerDialog';

function Proof() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [created, setCreated] = useState('');
  return (
    <View>
      <TouchableOpacity testID="add-corner" onPress={() => setOpen(true)}>
        <Text>Add corner</Text>
      </TouchableOpacity>
      <NewCornerDialog
        visible={open}
        title={title}
        setTitle={setTitle}
        creating={false}
        onCreate={() => {
          setCreated(title.trim());
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
      <Text testID="created-corner">{created}</Text>
    </View>
  );
}

createRoot(document.getElementById('root')!).render(<Proof />);

const result = document.getElementById('result')!;
const lines: string[] = [];
function check(label: string, pass: boolean) {
  lines.push(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  result.textContent = lines.join('\n');
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

async function run() {
  await pause();
  document.querySelector<HTMLElement>('[data-testid="add-corner"]')!.click();
  await pause();
  const sheet = document.querySelector<HTMLElement>('[data-testid="new-corner-dialog"]');
  check(
    'plus opens Begin a new corner sheet',
    Boolean(sheet?.textContent?.includes('Begin a new corner')),
  );
  check('sheet has one name field', sheet?.querySelectorAll('input').length === 1);
  check(
    'sheet has no subtitle or Corner App reference',
    !sheet?.textContent?.includes('human-owned') && !sheet?.textContent?.includes('Corner App'),
  );

  const input = sheet!.querySelector<HTMLInputElement>('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
    input,
    'Release notes',
  );
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await pause();
  const open = document.querySelector<HTMLElement>('[data-testid="create-corner-submit"]');
  check(
    'sheet offers Open corner and Cancel',
    Boolean(
      open?.textContent === 'Open corner' &&
      document.querySelector('[data-testid="create-corner-cancel"]')?.textContent === 'Cancel',
    ),
  );
  open!.click();
  await pause();
  check(
    'Open corner opens the named corner',
    document.querySelector<HTMLElement>('[data-testid="created-corner"]')?.textContent ===
      'Release notes',
  );
  lines.push(lines.every((line) => line.startsWith('PASS')) ? 'RESULT PASS' : 'RESULT FAIL');
  result.textContent = lines.join('\n');
}

void run();
