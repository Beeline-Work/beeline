// Static image assets (Metro asset modules). Vite test runs resolve the
// same default import to a path string; the type stays honest for Metro.
declare module '*.png' {
  const asset: number;
  export default asset;
}
