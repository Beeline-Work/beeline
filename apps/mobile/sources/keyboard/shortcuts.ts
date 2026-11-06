export type GlobalShortcutId = 'newSession' | 'settings';
export type ShortcutModifier = 'meta' | 'control';

export interface KeyboardShortcutEvent {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    isComposing?: boolean;
    repeat?: boolean;
    getModifierState?: (key: string) => boolean;
}

export const GLOBAL_SHORTCUTS: ReadonlyArray<{
    id: GlobalShortcutId;
    key: string;
    code: string;
    keyLabel: string;
}> = [
    { id: 'newSession', key: 'n', code: 'KeyN', keyLabel: 'N' },
    { id: 'settings', key: ',', code: 'Comma', keyLabel: ',' },
];

export function getGlobalShortcutId(
    event: KeyboardShortcutEvent,
    browserSafe = false,
): GlobalShortcutId | null {
    if (
        event.isComposing
        || event.getModifierState?.('AltGraph')
        || event.altKey !== browserSafe
        || event.shiftKey
        || (!event.metaKey && !event.ctrlKey)
    ) {
        return null;
    }

    return GLOBAL_SHORTCUTS.find((shortcut) => event.code
        ? shortcut.code === event.code
        : shortcut.key === event.key.toLowerCase()
    )?.id ?? null;
}

export function getRecentSessionShortcutIndex(
    event: KeyboardShortcutEvent,
    browserSafe = false,
): number | null {
    if (
        event.isComposing
        || event.getModifierState?.('AltGraph')
        || event.altKey !== browserSafe
        || event.shiftKey
        || (!event.metaKey && !event.ctrlKey)
    ) {
        return null;
    }

    const codeMatch = event.code?.match(/^(?:Digit|Numpad)([1-9])$/);
    if (codeMatch) {
        return Number(codeMatch[1]) - 1;
    }
    return /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : null;
}

export function getPressedShortcutModifier(event: Pick<KeyboardShortcutEvent, 'key' | 'altKey'>): ShortcutModifier | null {
    if (event.altKey) {
        return null;
    }
    if (event.key === 'Meta') {
        return 'meta';
    }
    if (event.key === 'Control') {
        return 'control';
    }
    return null;
}

export function getShortcutModifierLabel(modifier: ShortcutModifier): string {
    return modifier === 'meta' ? '⌘' : 'Ctrl';
}

export function formatShortcut(
    modifier: ShortcutModifier,
    keyLabel: string,
    browserSafe = false,
): string {
    const modifierLabel = getShortcutModifierLabel(modifier);
    if (modifier === 'meta') {
        return `${browserSafe ? '⌥' : ''}${modifierLabel}${keyLabel}`;
    }
    return `${modifierLabel}${browserSafe ? '+Alt' : ''}+${keyLabel}`;
}
