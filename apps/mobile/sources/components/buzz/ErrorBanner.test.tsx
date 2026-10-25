import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { View: host('View'), Text: host('Text') };
});
vi.mock('./Button', () => ({ Button: (props: any) => React.createElement('Button', props) }));
import { ErrorBanner } from './ErrorBanner';
it('keeps Retry and Dismiss independently operable on a failed delivery', async () => {
  const retry = vi.fn(),
    dismiss = vi.fn();
  let tree: any;
  await act(async () => {
    tree = create(
      <ErrorBanner inline
        title="Delivery failed"
        retryLabel="Retry"
        onRetry={retry}
        secondaryAction={{ label: 'Dismiss', onPress: dismiss }}
        testID="delivery"
      />,
    );
  });
  const actions = tree.root.findAllByType('Button');
  expect(actions.every((node: any) => node.props.size === 'inline')).toBe(true);
  expect(actions.map((node: any) => node.props.label)).toEqual(['Retry', 'Dismiss']);
  await act(async () => actions[0].props.onPress());
  expect(retry).toHaveBeenCalledOnce();
  expect(dismiss).not.toHaveBeenCalled();
  await act(async () => actions[1].props.onPress());
  expect(dismiss).toHaveBeenCalledOnce();
  expect(tree.root.findAllByType('View').find((node: any) => node.props.testID === 'delivery').props.accessibilityRole).toBe('alert');
  await act(async () => tree.unmount());
});
