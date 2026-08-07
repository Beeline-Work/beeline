/**
 * react-native-reanimated must be imported once at the entry point,
 * before any component that uses it renders.
 *
 * @format
 */
import 'react-native-reanimated';

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
