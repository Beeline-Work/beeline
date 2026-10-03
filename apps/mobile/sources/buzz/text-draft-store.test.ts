import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextDraft, textDraftKey, type DraftStorage } from './text-draft-store';
import { desktopDraftKey } from './desktop-workbench-state';
const tick = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
let values: Map<string, string>;
let storage: DraftStorage;
beforeEach(() => {
  vi.useFakeTimers();
  values = new Map();
  storage = {
    getItem: vi.fn(async (key) => values.get(key) ?? null),
    setItem: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key) => {
      values.delete(key);
    }),
  };
});
afterEach(() => vi.useRealTimers());
describe('durable controlled drafts', () => {
  it('restores without erasing on the initial empty render; server defaults do not overwrite it', async () => {
    values.set('restore', JSON.stringify('saved'));
    const draft = new TextDraft('restore', storage, '');
    expect(draft.value).toBe('');
    await draft.hydrate();
    draft.initialize('server');
    expect(draft.value).toBe('saved');
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it('changes immediately and debounces each keystroke for 500ms', async () => {
    const draft = new TextDraft('debounce', storage, '');
    draft.set('one');
    expect(draft.value).toBe('one');
    await vi.advanceTimersByTimeAsync(499);
    expect(values.has('debounce')).toBe(false);
    draft.set('two');
    await vi.advanceTimersByTimeAsync(499);
    expect(values.has('debounce')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(values.get('debounce')).toBe(JSON.stringify('two'));
  });
  it('late hydration cannot overwrite typing or a staged forward', async () => {
    let release!: (value: string) => void;
    storage.getItem = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const draft = new TextDraft('late', storage, '');
    const hydration = draft.hydrate();
    await tick();
    draft.set('forward + typing');
    release(JSON.stringify('old'));
    await hydration;
    expect(draft.value).toBe('forward + typing');
    draft.dispose();
    await tick();
  });
  it('an older completion preserves newer typing, including identical replacement text', async () => {
    const draft = new TextDraft('newer', storage, '');
    draft.set('first');
    const clear = draft.capture();
    draft.set('first');
    expect(clear()).toBe(false);
    await draft.flush();
    expect(values.get('newer')).toBe(JSON.stringify('first'));
  });
  it('consumes a sent message prefix once and orders its suffix after an in-flight save', async () => {
    let release!: () => void;
    storage.setItem = vi.fn(async (key, value) => {
      if (value === JSON.stringify('sent next'))
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      values.set(key, value);
    });
    const draft = new TextDraft('message-prefix', storage, '');
    draft.set('sent');
    const accept = draft.captureMessage();
    draft.set('sent next');
    const save = draft.flush();
    await tick();
    expect(accept()).toBe(true);
    expect(draft.value).toBe(' next');
    release();
    await save;
    await tick();
    expect(values.get('message-prefix')).toBe(JSON.stringify(' next'));
    expect(accept()).toBe(false);
    draft.dispose();
  });
  it('preserves message replacement edits, including identical retyping and edits from a new mount', async () => {
    const draft = new TextDraft('message-replacement', storage, '');
    draft.set('sent');
    const accept = draft.captureMessage();
    draft.set('revised message');
    expect(accept()).toBe(false);
    expect(draft.value).toBe('revised message');
    draft.set('sent');
    const identical = draft.captureMessage();
    draft.set('sent');
    expect(identical()).toBe(false);
    const olderMount = draft.captureMessage();
    draft.dispose();
    const reopened = new TextDraft('message-replacement', storage, '');
    await reopened.hydrate();
    reopened.set('sent new mount');
    expect(olderMount()).toBe(false);
    await reopened.flush();
    expect(values.get('message-replacement')).toBe(JSON.stringify('sent new mount'));
    reopened.dispose();
  });
  it('a rejected message keeps its full edited draft for retry', async () => {
    const draft = new TextDraft('message-failure', storage, '');
    draft.set('unsent');
    draft.captureMessage();
    draft.set('unsent next');
    await draft.flush();
    const reopened = new TextDraft('message-failure', storage, '');
    await reopened.hydrate();
    expect(reopened.value).toBe('unsent next');
    draft.dispose();
  });
  it('success cancels pending saves and a same-key remount stays empty', async () => {
    const draft = new TextDraft('success', storage, '');
    draft.set('submitted');
    expect(draft.capture()()).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    draft.dispose();
    const reopened = new TextDraft('success', storage, '');
    await reopened.hydrate();
    expect(reopened.value).toBe('');
    expect(values.has('success')).toBe(false);
  });
  it('serializes an in-flight write before its successful delete', async () => {
    let release!: () => void;
    storage.setItem = async (key, value) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      values.set(key, value);
    };
    const draft = new TextDraft('ordered', storage, '');
    draft.set('old');
    const save = draft.flush();
    await tick();
    draft.capture()();
    release();
    await save;
    await tick();
    expect(values.has('ordered')).toBe(false);
  });
  it('failed submissions and navigation flushes survive remount', async () => {
    const draft = new TextDraft('failure', storage, '');
    draft.set('unsent');
    draft.capture();
    draft.dispose();
    const restarted = new TextDraft('failure', storage, '');
    await restarted.hydrate();
    expect(restarted.value).toBe('unsent');
  });
  it('a completion from a previous mount cannot delete or flush over newer typing', async () => {
    const first = new TextDraft('remounted-newer', storage, '');
    first.set('old');
    const clear = first.capture();
    first.dispose();
    await tick();
    const newer = new TextDraft('remounted-newer', storage, '');
    await newer.hydrate();
    newer.set('new text');
    await newer.flush();
    expect(clear()).toBe(false);
    await first.flush();
    expect(values.get('remounted-newer')).toBe(JSON.stringify('new text'));
  });
  it('keeps submitted profile text as a default without resurrecting its removed draft', async () => {
    const draft = new TextDraft('profile', storage, '');
    draft.set('Saved name');
    await draft.flush();
    draft.capture(false)();
    await tick();
    await draft.flush();
    expect(draft.value).toBe('Saved name');
    expect(values.has('profile')).toBe(false);
    draft.initialize('Updated server name');
    expect(draft.value).toBe('Updated server name');
  });
  it('isolates identities, resources and separators', () => {
    expect(
      new Set([
        textDraftKey('alice', 'room:one'),
        textDraftKey('bob', 'room:one'),
        textDraftKey('alice', 'room:two'),
        textDraftKey('alice:room', 'one'),
      ]).size,
    ).toBe(4);
  });
  it('migrates desktop text and removes the legacy record so cleared text cannot reappear', async () => {
    const legacy = desktopDraftKey('room/one');
    values.set(legacy, 'desktop text');
    const draft = new TextDraft('migrated', storage, '', legacy);
    await draft.hydrate();
    expect(draft.value).toBe('desktop text');
    expect(values.get('migrated')).toBe(JSON.stringify('desktop text'));
    expect(values.has(legacy)).toBe(false);
    draft.capture()();
    const reopened = new TextDraft('migrated', storage, '', legacy);
    await reopened.hydrate();
    expect(reopened.value).toBe('');
  });
  it('does not save server defaults; removes an intentionally emptied search', async () => {
    const draft = new TextDraft('search', storage, '');
    draft.initialize('server');
    await draft.flush();
    expect(values.has('search')).toBe(false);
    draft.set('query');
    await draft.flush();
    draft.set('');
    await draft.flush();
    expect(values.has('search')).toBe(false);
  });
  it('restores arrays, tolerates malformed storage and rejected operations, and never saves disabled contexts', async () => {
    const draft = new TextDraft('options', storage, ['', '']);
    draft.set(['Yes', 'No']);
    await draft.flush();
    const reopened = new TextDraft('options', storage, ['', '']);
    await reopened.hydrate();
    expect(reopened.value).toEqual(['Yes', 'No']);
    values.set('invalid', '{');
    const invalid = new TextDraft('invalid', storage, 'default');
    await invalid.hydrate();
    expect(invalid.value).toBe('default');
    const broken: DraftStorage = {
      getItem: async () => {
        throw Error('read');
      },
      setItem: async () => {
        throw Error('full');
      },
      removeItem: async () => {
        throw Error('delete');
      },
    };
    const resilient = new TextDraft('broken', broken, '');
    await resilient.hydrate();
    resilient.set('typing');
    await resilient.flush();
    expect(resilient.value).toBe('typing');
    resilient.capture()();
    await tick();
    const secret = new TextDraft(null, storage, '');
    secret.set('secret');
    await secret.flush();
    expect([...values.values()]).not.toContain(JSON.stringify('secret'));
  });
});
