module.exports = function(api) { api.cache(true); return { presets: [require.resolve('../node_modules/babel-preset-expo')] }; };
