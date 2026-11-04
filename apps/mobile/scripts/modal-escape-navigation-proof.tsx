import React from 'react';
// @ts-expect-error Standalone browser proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { HullFloatingSurface, HullModal } from '@/components/buzz/HullDialog';
import { BrowserNavigationShortcuts } from '@/hooks/useBrowserNavigationShortcuts';
import { useBrowserNavigationStore } from '@/navigation/browserNavigationStore';

const facts = { routeBacks: 0, closes: 0, backsOnKeyDown: -1, modalClosed: false };
Object.assign(window, { modalEscapeFacts: facts });
const route = window.location.pathname + window.location.search;
useBrowserNavigationStore.setState({ routeHistory: { stack: ['/tray', route], cursor: 1 } });

function Surface() {
  const [visible, setVisible] = React.useState(true);
  return (
    <View>
      <BrowserNavigationShortcuts />
      <HullModal animationType="none" visible={visible} onRequestClose={() => { facts.closes += 1; setVisible(false); }}>
        <HullFloatingSurface><Text>Add-agent proof</Text></HullFloatingSurface>
      </HullModal>
    </View>
  );
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 500));
const key = (type: string) => (document.activeElement ?? document.body).dispatchEvent(
  new KeyboardEvent(type, { key: 'Escape', bubbles: true, cancelable: true }),
);
async function read() {
  createRoot(document.getElementById('root')!).render(<Surface />);
  await pause();
  if (!document.querySelector('[role="dialog"][aria-modal="true"]')) throw new Error('Modal did not open');
  key('keydown');
  facts.backsOnKeyDown = facts.routeBacks;
  key('keyup');
  await pause();
  facts.modalClosed = !document.querySelector('[role="dialog"][aria-modal="true"]');
  key('keydown');
  document.getElementById('result')!.textContent = JSON.stringify(facts);
}
void read().catch((error) => { document.getElementById('result')!.textContent = `FAIL ${error.message}`; });
