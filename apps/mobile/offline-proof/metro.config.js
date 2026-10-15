// Reuse the existing Expo Go proof adapters and app alias resolution.
const config = require('../rail-proof/metro.config');
config.projectRoot = __dirname;
module.exports = config;
