import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('./Button', () => ({ Button: 'Button' }));
import { ButtonRow } from './ButtonRow';

it('rejects multiple filled choices and links inside a decision row', () => {
  const onPress = () => {};
  expect(() =>
    ButtonRow({
      actions: [
        { label: 'Once', variant: 'primary', onPress },
        { label: 'Always', variant: 'primary', onPress },
      ],
    }),
  ).toThrow('one primary');
  expect(() =>
    ButtonRow({ actions: [{ label: 'View request', accessibilityRole: 'link', onPress }] }),
  ).toThrow('outside ButtonRow');
  expect(() =>
    ButtonRow({
      actions: [
        { label: 'No', variant: 'secondary', onPress },
        { label: 'Once', variant: 'secondary', onPress },
        { label: 'Always', variant: 'primary', onPress },
      ],
    }),
  ).not.toThrow();
});
