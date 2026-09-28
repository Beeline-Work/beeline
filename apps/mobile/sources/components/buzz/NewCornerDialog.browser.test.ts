import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

describe.skipIf(!existsSync(CHROME))('New corner sheet in a browser', () => {
  it('shows a name-only form and creates the named corner', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/new-corner-dialog-proof.tsx'),
      mobile,
      width: 390,
      shims: {
        ...webProofShims(mobile),
        '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
        '@/components/buzz/HullDialog': `import { TextInput } from 'react-native';
          export const HullDialogInput = props => <TextInput {...props} />;`,
        './HullDialog': `import { TextInput } from 'react-native';
          export const HullDialogInput = props => <TextInput {...props} />;`,
        './HullActionSheet': `import { Text, View } from 'react-native';
          export const HULL_SHEET_INSET = 22;
          export const HullActionSheetModal = ({ visible, title, children, footer, testID }) =>
            visible ? <View testID={testID}><Text>{title}</Text>{children}{footer}</View> : null;`,
      },
    });
    expect(status, stderr).toBe(0);
    console.log(result);
    expect(result).toContain('RESULT PASS');
  }, 90_000);
});
