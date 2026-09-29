import React from 'react';
import {Composition, continueRender, delayRender} from 'remotion';
import {TestAtlasFull} from './TestAtlasFull';
import {fontsReady} from './theme';
import {DURATION, FPS} from './timingFull';

const fontHandle = delayRender('Loading brand fonts');
fontsReady.then(() => continueRender(fontHandle));

export const Root: React.FC = () => (
  <Composition id="TestAtlasFull" component={TestAtlasFull} durationInFrames={Math.round(DURATION * FPS)} fps={FPS} width={1080} height={1920} />
);
