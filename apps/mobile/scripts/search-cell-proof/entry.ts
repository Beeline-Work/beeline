import 'react-native-get-random-values';
require('../../sources/unistyles');
require('react-native-unistyles').UnistylesRuntime.setTheme('bone');
const {registerRootComponent}=require('expo');
registerRootComponent(require('./screen').default);
