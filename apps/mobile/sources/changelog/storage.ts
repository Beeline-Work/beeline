import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();

const LAST_VIEWED_KEY = 'changelog-last-viewed-title';

export function setLastViewedTitle(title: string): void {
    mmkv.set(LAST_VIEWED_KEY, title);
}
