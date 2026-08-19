import { describe, expect, it } from 'vitest';
import {
  AGENT_ERROR_STATE_MESSAGES,
  classifyAgentErrorState,
  type AgentErrorState,
} from './agent-state-messages.js';

describe('classifyAgentErrorState', () => {
  it('classifies a generic ACP exit as harness-unavailable', () => {
    const error = new Error('ACP agent codex exited code=1 signal=null');
    expect(classifyAgentErrorState(error)).toBe('harness-unavailable');
  });

  it('classifies an ACP exit whose stderr mentions a missing API key as harness-auth-missing', () => {
    const error = new Error(
      'ACP agent codex exited code=1 signal=null: Error: ANTHROPIC_API_KEY is not set',
    );
    expect(classifyAgentErrorState(error)).toBe('harness-auth-missing');
  });

  it('classifies an ACP exit whose stderr mentions unauthorized as harness-auth-missing', () => {
    const error = new Error('ACP agent claude exited code=1 signal=null: 401 Unauthorized');
    expect(classifyAgentErrorState(error)).toBe('harness-auth-missing');
  });

  it('classifies a rate-limit-shaped error as rate-limited', () => {
    expect(classifyAgentErrorState(new Error('request failed: HTTP 429 Too Many Requests'))).toBe(
      'rate-limited',
    );
    expect(classifyAgentErrorState(new Error('rate limit exceeded, please retry'))).toBe(
      'rate-limited',
    );
    expect(classifyAgentErrorState(new Error('quota exceeded for this model'))).toBe(
      'rate-limited',
    );
  });

  it('does not misclassify the existing ACP idle-stall error', () => {
    const error = new Error('ACP session/prompt timed out after 180000ms of inactivity');
    expect(classifyAgentErrorState(error)).toBeNull();
  });

  it('returns null for an unrelated error', () => {
    expect(classifyAgentErrorState(new Error('something else entirely went wrong'))).toBeNull();
  });

  it('handles a non-Error thrown value', () => {
    expect(classifyAgentErrorState('ACP agent codex exited code=1 signal=null')).toBe(
      'harness-unavailable',
    );
  });
});

describe('AGENT_ERROR_STATE_MESSAGES', () => {
  it('has a non-empty hard-coded message for every AgentErrorState', () => {
    const states: AgentErrorState[] = [
      'relay-disconnected',
      'harness-auth-missing',
      'harness-unavailable',
      'repo-unavailable',
      'rate-limited',
    ];
    for (const state of states) {
      expect(AGENT_ERROR_STATE_MESSAGES[state]).toBeTruthy();
      expect(typeof AGENT_ERROR_STATE_MESSAGES[state]).toBe('string');
    }
    expect(Object.keys(AGENT_ERROR_STATE_MESSAGES).sort()).toEqual([...states].sort());
  });
});
