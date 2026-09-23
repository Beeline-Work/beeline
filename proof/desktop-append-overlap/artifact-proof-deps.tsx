import React from 'react';
import { View } from 'react-native';

const IMAGE_URI = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1200"><rect width="2000" height="1200" fill="#bc7194"/><circle cx="1000" cy="600" r="400" fill="#f5dc88"/></svg>')}`;

// The image case uses only artifactImageSource. These stand-ins let the proof
// mount the production ArtifactCard and ArtifactImage without booting app
// session, storage, PDF, WebView, navigation, or modal services.
export async function artifactImageSource() {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { uri: IMAGE_URI };
}
export function releaseArtifactImageSource() {}
export function formatAttachmentSize(size: number) { return `${size} B`; }
export function artifactPreviewCachePath() { return ''; }
export async function probeArtifactPreview() { return null; }
export async function snapshotArtifactPreview() { return null; }
export const ARTIFACT_PDF_BASE_URL = '';
export const ARTIFACT_PDF_RENDER_TIMEOUT_MS = 1000;
export async function loadPdfViewerDocument() { return ''; }
export function pdfRenderedSignalGuard() { return () => false; }
export async function artifactBase64() { return ''; }
export async function artifactPdfLocalUri() { return ''; }
export async function fetchArtifactBytes() { return new Uint8Array(); }
export async function fetchArtifactText() { return ''; }
export async function openArtifactInBrowserOrExplain() {}
export function openArtifactInDesktopWorkPane() {}
export function artifactWebViewProps() { return {}; }
export function useSandboxWebView() { return null; }
export function ArtifactPdfView() { return <View />; }
export function ArtifactViewerScreen() { return <View />; }
export const CHEVRON_ROW_SIZE = 16;
export function ChevronGlyph() { return <View />; }
export function MonoMarkdown() { return <View />; }
export const Modal = { show() {} };
