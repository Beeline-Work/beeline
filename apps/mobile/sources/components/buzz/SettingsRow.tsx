import React from 'react';
import { IndexRow, type IndexRowActionControl, type IndexRowProps } from './IndexRow';

export type SettingsRowActionControl = IndexRowActionControl;

type SettingsRowProps = Omit<IndexRowProps, 'density' | 'inset' | 'accessibilityRole'> & {
  accessibilityRole?: 'button' | 'link';
};

/**
 * The page preset of the one index row (`IndexRow`): `layout.row` tall, on
 * the row inset, one hairline beneath. The account hub, Workspace Settings
 * and Members all read through it.
 */
export function SettingsRow(props: SettingsRowProps) {
  return <IndexRow {...props} density="page" inset="row" />;
}
