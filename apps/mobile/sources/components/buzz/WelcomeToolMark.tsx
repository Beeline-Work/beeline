import React from 'react';
import { Image } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { welcomeBrandMarks } from './welcome-brand-marks';

export function WelcomeToolMark({ name }: { name: keyof typeof welcomeBrandMarks }) {
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
  return <SvgXml xml={welcomeBrandMarks[name]} width={30} height={30} />;
}
