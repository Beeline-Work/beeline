import React from 'react';
import {useCurrentFrame} from 'remotion';
import {Environment} from './Environment';

// Five seconds, one second per environment mode, for look-dev.
export const EnvTest: React.FC = () => {
  const t = useCurrentFrame() / 60;
  const mode = Math.min(4, Math.floor(t));
  const w: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  w[mode] = 1;
  return <Environment u={{t: t + 3, beat: 0.4, down: 0.3, flow: t * 1.5, heat: 0.6, w, shock: 99}} />;
};
