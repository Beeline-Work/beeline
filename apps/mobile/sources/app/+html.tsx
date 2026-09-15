import { ScrollViewStyleReset } from 'expo-router/html';
import '../unistyles';

// This file is web-only and used to configure the root HTML for every
// web page during static rendering.
// The contents of this function only run in Node.js environments and
// do not have access to the DOM or browser APIs.
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />

        {/* 
          Disable body scrolling on web. This makes ScrollView components work closer to how they do on native. 
          However, body scrolling is often nice to have for mobile web. If you want to enable it, remove this line.
        */}
        <ScrollViewStyleReset />

        {/* Using raw CSS styles as an escape-hatch to ensure the background color never flickers in dark-mode. */}
        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />
        {/* Synchronous, blocking (no defer/async/module) so it runs before first
            paint: the persisted Appearance choice lives in browser storage, which
            this Node-rendered file can't read, so the override has to happen in
            the browser itself, before the CSS default above would otherwise flash. */}
        <script dangerouslySetInnerHTML={{ __html: appearanceOverrideScript }} />
        {/* Add any additional <head> elements that you want globally available on web... */}
      </head>
      <body>{children}</body>
    </html>
  );
}

// The Appearance setting defaults to Obsidian (dark) regardless of OS color
// scheme — see `sync/localSettings.ts`'s `localSettingsDefaults` — so this
// static default matches that, and the script below is what actually reads
// the user's choice once the page has browser storage to read it from.
const responsiveBackground = `
body {
  /* Speakeasy brand canvas — the same value the unistyles themes carry. */
  background-color: #14091A;
}`;

// Mirrors sync/browser-string-storage.ts's namespacing ('beeline.settings.' +
// 'local-settings') and localSettings.ts's `appearance` field — kept as a
// literal read rather than importing those modules, since this file must stay
// framework-free (it runs in Node during static export, per the comment
// above; this string only ever executes in the browser).
const appearanceOverrideScript = `
(function () {
  try {
    var raw = window.localStorage.getItem('beeline.settings.local-settings');
    var parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.appearance === 'light') {
      var style = document.createElement('style');
      /* Bone canvas — apps/mobile/sources/buzz/groknight.ts beelineThemes.bone.bgVoid */
      style.textContent = 'body { background-color: #F3EEE4; }';
      document.head.appendChild(style);
    }
  } catch (e) {}
})();`;
