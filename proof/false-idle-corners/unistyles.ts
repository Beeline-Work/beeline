import { beelineThemes } from '../../apps/mobile/sources/buzz/groknight';
const buzz = beelineThemes[new URLSearchParams(location.search).get('theme') === 'bone' ? 'bone' : 'obsidian'];
export const StyleSheet = {create: (styles: any) => typeof styles === 'function' ? styles({buzz}) : styles};
export const useUnistyles = () => ({theme:{buzz},rt:{}});
