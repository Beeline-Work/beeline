import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The sheet row's trailing column is a CLOSED vocabulary on ONE axis
 * (captain report C102). Five rows once carried a pencil, an empty square, a
 * filled circle, a clock and a red square — two of which read as unticked
 * checkboxes and were not — each inside its own framed slab. This pins what
 * replaced them: a value, a switch, a chevron, or nothing at all, every form
 * ending on the sheet's own trailing inset, and no row wearing a box.
 */
const theme = vi.hoisted(() => ({
  hull: {
    accent: '#b08a4a',
    bgPressed: '#2a1b31',
    bgRaised: '#1d1024',
    border: '#39273f',
    chrome: '#f1edf2',
    dialogDanger: '#c4544d',
    proseRegular: 'GrokRegular',
    proseSemibold: 'GrokSemibold',
    radius: 3,
    space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
    textDisabled: '#75687a',
    textMuted: '#83838d',
    textPrimary: '#f1edf2',
    textSecondary: '#aaa0ae',
    type: {
      body: { fontFamily: 'GrokRegular', fontSize: 16, lineHeight: 23, letterSpacing: 0 },
      bodyStrong: { fontFamily: 'GrokSemibold', fontSize: 16, lineHeight: 23, letterSpacing: 0 },
      hero: { fontFamily: 'GrokMedium', fontSize: 22, lineHeight: 32, letterSpacing: -0.3 },
      meta: { fontFamily: 'GrokRegular', fontSize: 13, lineHeight: 19, letterSpacing: 0 },
    },
  },
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
    Modal: host('Modal'),
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Switch: host('Switch'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    absoluteFill: { position: 'absolute', inset: 0 },
    create: (factory: unknown) =>
      typeof factory === 'function'
        ? (factory as (theme: any) => unknown)({ buzz: theme.hull })
        : factory,
    hairlineWidth: 1,
  },
  useUnistyles: () => ({ theme: { buzz: theme.hull } }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 12, left: 0 }),
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('./HullDialog', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { HullFloatingSurface: host('HullFloatingSurface'), HullModal: host('HullModal') };
});

vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));

import { CornerLockAction } from './CornerLockAction';
import { fileURLToPath } from 'node:url';
// Runtime imports keep the server under its own TypeScript configuration.
const serverSource = new URL('../../../../server/src/', import.meta.url);
const serverBuilt = new URL('../../../../server/dist/', import.meta.url);
const server = process.env.CORNER_LOCK_BUILT === '1' ? serverBuilt : serverSource;
const extension = process.env.CORNER_LOCK_BUILT === '1' ? 'js' : 'ts';
const { PgliteDatabase } = await import(/* @vite-ignore */ fileURLToPath(new URL('test-support.ts', serverSource)));
const { migrate } = await import(/* @vite-ignore */ fileURLToPath(new URL(`database.${extension}`, server)));
const { PhoneService } = await import(/* @vite-ignore */ fileURLToPath(new URL(`phone-service.${extension}`, server)));
import { readRoomView } from '@beeline/api-contract/phone';

const H = 'a'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
let db: InstanceType<typeof PgliteDatabase>;
let phone: InstanceType<typeof PhoneService>;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Person')`, [H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [R,W]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`, [W,H,R]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`, [C,W,R,H]);
  await db.query(`INSERT INTO corner_facts(corner_id,kind) VALUES($1,'human')`, [C]);
  phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => { await db?.close(); });

describe('corner menu Lock corner toggle', () => {
  it.each(['obsidian', 'bone'])('persists both toggle directions on the server in %s', async (palette) => {
    if (palette === 'bone') Object.assign(theme.hull, {
      bgRaised: '#ECE4D5', textPrimary: '#171310', textSecondary: '#4A4038',
      textMuted: '#8B7F6E', accent: '#8a6323',
    });
    await phone.execute('setCornerLocked', { roomId: C, locked: false }, H);
    const read = async () => readRoomView(await phone.readRoom(C,H))!;
    let view = await read();
    let tree: ReactTestRenderer;
    const error = vi.fn();
    const save = (locked: boolean) => phone.execute('setCornerLocked', { roomId: C, locked }, H);
    const render = () => <CornerLockAction locked={view.cornerLocked === true} save={save}
      onSaved={() => undefined} onError={error} />;
    await act(async () => { tree = create(render()); });
    const row = () => tree!.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === 'lock-corner-action')[0]!;
    expect(row().props.accessibilityLabel).toContain('Lock corner');
    expect(row().props.accessibilityState.checked).toBe(false);
    await act(async () => { await row().props.onPress(); });
    view = await read();
    expect(view.cornerLocked).toBe(true);
    await act(async () => { tree!.update(render()); });
    expect(row().props.accessibilityState.checked).toBe(true);
    await act(async () => { await row().props.onPress(); });
    expect((await read()).cornerLocked).toBe(false);
    expect(error).not.toHaveBeenCalled();
    await act(async () => { tree!.unmount(); });
  });
});
