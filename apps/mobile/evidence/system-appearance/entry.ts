import { Appearance } from 'react-native';
import { UnistylesRuntime } from 'react-native-unistyles';
import { applyAppearanceChoice } from '../../sources/unistyles';
import { loadLocalSettings, saveLocalSettings } from '../../sources/sync/persistence';

const root = document.getElementById('root')!;
root.innerHTML = '<h1>Appearance</h1><select aria-label="Appearance"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select><pre id="result"></pre>';
const select = root.querySelector('select')!;
select.value = loadLocalSettings().appearance;
const receipts: unknown[] = [];
function record() {
  const receipt = {
    choice: select.value,
    system: Appearance.getColorScheme(),
    theme: UnistylesRuntime.themeName,
    background: getComputedStyle(document.body).backgroundColor,
    darkMedia: matchMedia('(prefers-color-scheme: dark)').matches,
  };
  receipts.push(receipt);
  document.getElementById('result')!.textContent = JSON.stringify(receipts, null, 2);
  fetch('http://127.0.0.1:4199/receipt', { method: 'POST', body: JSON.stringify(receipt) }).catch(() => {});
}
select.onchange = () => {
  const appearance = select.value as 'system' | 'light' | 'dark';
  saveLocalSettings({ ...loadLocalSettings(), appearance });
  applyAppearanceChoice(appearance, 'medium');
  setTimeout(record, 100);
};
Appearance.addChangeListener(() => setTimeout(record, 100));
setTimeout(record, 200);
