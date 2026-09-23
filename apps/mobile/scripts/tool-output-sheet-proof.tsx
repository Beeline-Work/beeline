import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { fenceByteLength, formatFenceBytes } from '../sources/buzz/code-fence';
import {
  ToolOutputSheet,
  TOOL_OUTPUT_SHEET_MAX_WIDTH,
} from '../sources/components/buzz/ToolOutputSheet';
import { BookmarksGlyph } from '../sources/components/buzz/BookmarksGlyph';
import { ChevronGlyph } from '../sources/components/buzz/ChevronGlyph';
import { CornerGlyph } from '../sources/components/buzz/CornerGlyph';
import { MembersGlyph } from '../sources/components/buzz/MembersGlyph';
import { MicGlyph } from '../sources/components/buzz/MicGlyph';
import { OverflowGlyph } from '../sources/components/buzz/OverflowGlyph';
import { RoomGlyph } from '../sources/components/buzz/RoomGlyph';

/** The cap a bottom-placed Hull sheet takes, which a phone gets. */
const PHONE_SHEET_MAX_WIDTH = 600;

const code = Array.from(
  { length: 40 },
  (_, index) => `const finding${index} = "a machine line long enough to need the room";`,
).join('\n');
const size = formatFenceBytes(fenceByteLength(code));

function Surface() {
  return (
    <View>
      <ToolOutputSheet
        detail={code}
        onClose={() => undefined}
        subtitle={`40 lines · ${size}`}
        title="Output"
        visible
      />
      {/* Every drawn mark, painted on the same page as the sheet: each one
          used to log an unrecognized-prop error the moment it mounted. */}
      <BookmarksGlyph color="#ffffff" />
      <ChevronGlyph color="#ffffff" direction="down" />
      <CornerGlyph color="#ffffff" />
      <MembersGlyph color="#ffffff" />
      <MicGlyph color="#ffffff" />
      <OverflowGlyph color="#ffffff" />
      <RoomGlyph color="#ffffff" />
    </View>
  );
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

function sizeBearingText(): string[] {
  return Array.from(document.querySelectorAll('*'))
    .filter((element) => element.children.length === 0)
    .map((element) => element.textContent ?? '')
    .filter((text) => text.includes(size));
}

async function measure() {
  createRoot(document.getElementById('root')!).render(<Surface />);
  await pause();

  const sheet = document.querySelector<HTMLElement>('[data-testid="tool-output-sheet"]');
  assert(sheet != null, 'the sheet did not open');
  const width = sheet!.getBoundingClientRect().width;
  assert(
    width === TOOL_OUTPUT_SHEET_MAX_WIDTH,
    `sheet opened at ${width}, not its ${TOOL_OUTPUT_SHEET_MAX_WIDTH} cap`,
  );
  assert(
    width > PHONE_SHEET_MAX_WIDTH,
    `desktop sheet at ${width} is no wider than the ${PHONE_SHEET_MAX_WIDTH} a phone gets`,
  );
  const outputScroll = document.querySelector<HTMLElement>('[data-testid="tool-output-scroll"]');
  assert(outputScroll != null, 'the output scroll view is missing');
  assert(
    outputScroll!.getBoundingClientRect().bottom <= window.innerHeight,
    'the output scroll view extends beyond the viewport',
  );
  assert(outputScroll!.scrollHeight > outputScroll!.clientHeight, 'long output did not scroll');

  // The sheet reports the supplied size once. The Copy row adds no duplicate.
  const bearing = sizeBearingText();
  assert(bearing.length === 1, `byte size reads ${bearing.length} times: ${bearing.join(' | ')}`);
  const copyRow = document.querySelector<HTMLElement>('[data-testid="tool-output-copy"]')!;
  assert(
    !copyRow.textContent?.includes(size),
    `Copy row still reports the size: ${copyRow.textContent}`,
  );
  assert(copyRow.getBoundingClientRect().bottom <= window.innerHeight, 'Copy output is offscreen');

  const unrecognised = (window as unknown as { __console: string[] }).__console.filter((entry) =>
    /does not recognize|accessibilityElementsHidden|importantForAccessibility/.test(entry),
  );
  assert(unrecognised.length === 0, `DOM prop errors: ${unrecognised.join(' | ')}`);

  report('PASS');
}

measure().catch((error) => report(String(error)));
