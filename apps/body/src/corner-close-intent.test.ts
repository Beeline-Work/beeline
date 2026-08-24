import { describe, expect, it } from 'vitest';
import { isCornerCloseRequest } from './corner-close-intent.js';

describe('isCornerCloseRequest', () => {
  it('recognizes the explicit imperative in its plain shapes', () => {
    expect(isCornerCloseRequest('Close this corner.')).toBe(true);
    expect(isCornerCloseRequest('close this corner')).toBe(true);
    expect(isCornerCloseRequest('Close the corner')).toBe(true);
    expect(isCornerCloseRequest('archive this corner')).toBe(true);
    expect(isCornerCloseRequest('Please close this corner')).toBe(true);
    expect(isCornerCloseRequest('can you close this corner?')).toBe(true);
    expect(isCornerCloseRequest('could you close the corner')).toBe(true);
    expect(isCornerCloseRequest('@beebee close this corner')).toBe(true);
    expect(isCornerCloseRequest('hey @beebee, please close this corner!')).toBe(true);
    expect(isCornerCloseRequest('go ahead and close the corner')).toBe(true);
  });

  it('never matches discussion, questions-about, or conditioned closes', () => {
    expect(isCornerCloseRequest('Should we close this corner after the review?')).toBe(false);
    expect(isCornerCloseRequest('why did you close this corner?')).toBe(false);
    expect(isCornerCloseRequest('close this corner and open a new one')).toBe(false);
    expect(isCornerCloseRequest('close this corner once the tests pass')).toBe(false);
    expect(isCornerCloseRequest("don't close this corner")).toBe(false);
    expect(isCornerCloseRequest('I want to close this corner myself later')).toBe(false);
    expect(isCornerCloseRequest('the corner is closed now, right?')).toBe(false);
    expect(isCornerCloseRequest('')).toBe(false);
  });

  it('does not match ordinary work requests that merely contain the words nearby', () => {
    expect(isCornerCloseRequest('close the failing test')).toBe(false);
    expect(isCornerCloseRequest('archive the old logs')).toBe(false);
    expect(isCornerCloseRequest('add a button that closes this corner from the UI')).toBe(false);
  });
});
