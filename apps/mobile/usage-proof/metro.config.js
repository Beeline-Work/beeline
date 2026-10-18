// Production meter with the existing Expo Go native-host adapters.
const { getDefaultConfig } = require('expo/metro-config');
const adapters = require('../rail-proof/metro.config.js');
const config = getDefaultConfig(__dirname);
config.resolver = adapters.resolver;
config.watchFolders = adapters.watchFolders;
config.maxWorkers = 2;
module.exports = config;
