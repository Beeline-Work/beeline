import React from 'react';
import { Image } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { welcomeBrandMarks } from './welcome-brand-marks';

export function WelcomeToolMark({ name }: { name: keyof typeof welcomeBrandMarks }) {
  const { theme } = useUnistyles();
  if (name === 'caldotcom') {
    return (
      <Image
        source={require('../../assets/images/calcom-official.png')}
        style={{ width: 30, height: 30 }}
      />
    );
  }
  if (name === 'coinbase') {
    return (
      <Image
        source={require('../../assets/images/coinbase-official.png')}
        style={{ width: 30, height: 30 }}
      />
    );
  }
  // Monochrome Simple Icons paths carry no fill of their own (they would paint
  // black, invisible on Obsidian); their ink follows the theme.
  return (
    <SvgXml xml={welcomeBrandMarks[name]} width={30} height={30} fill={theme.buzz.textPrimary} />
  );
}
