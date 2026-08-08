// Metro pins this package to the CJS build (see metro.config.js) so the
// ESM `import.meta.url` path never ships in the classic <script> web bundle.
import sodium from 'libsodium-wrappers';
export default sodium;