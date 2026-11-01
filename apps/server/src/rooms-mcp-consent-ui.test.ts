import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renderMcpWorkspaceSelection, MCP_WORKSPACE_SCRIPT } from './rooms-mcp-consent-ui.js';

describe('MCP workspace consent', () => {
  it('defaults all eligible workspaces selected and submits stable IDs to the consent form', () => {
    const html = renderMcpWorkspaceSelection([{ id: 'w1', name: 'Personal', publicRoomCount: 1 }, { id: 'w2', name: 'Team', publicRoomCount: 3 }]);
    expect(html).toContain('id="workspace-heading">Workspaces</p>');
    expect(html).not.toContain('all 2 selected');
    expect(html.match(/ checked/g)).toHaveLength(2);
    expect(html.match(/form="mcp-consent-form"/g)).toHaveLength(3);
    expect(html).toContain('name="workspace_selection" value="1"');
    expect(html).toContain('name="workspace_ids" value="w1"');
    expect(html).toContain('1 public Room</span>');
    expect(html).toContain('3 public Rooms</span>');
  });
  it('updates select-all, selection guidance and Allow without disabling Cancel', () => {
    const listeners = new Map<string, () => void>();
    const choices = [true, true].map((checked, index) => ({ checked, addEventListener: (_: string, listener: () => void) => listeners.set(String(index), listener) }));
    const toggle = { hidden: true, textContent: '', addEventListener: (_: string, listener: () => void) => listeners.set('toggle', listener) };
    const error = { hidden: true };
    const allow = { disabled: false };
    const form = { querySelector: (selector: string) => selector === 'button[value="allow"]' ? allow : null };
    const nodes: Record<string, unknown> = { 'mcp-consent-form': form, 'select-all-workspaces': toggle, 'selection-error': error };
    runInNewContext(MCP_WORKSPACE_SCRIPT, { document: { getElementById: (id: string) => nodes[id], querySelectorAll: () => choices } });
    expect(toggle.hidden).toBe(false);
    expect(toggle.textContent).toBe('Deselect all');
    listeners.get('toggle')!();
    expect(choices.every(choice => !choice.checked)).toBe(true);
    expect(allow.disabled).toBe(true);
    expect(error.hidden).toBe(false);
    expect(toggle.textContent).toBe('Select all');
    choices[0]!.checked = true;
    listeners.get('0')!();
    expect(allow.disabled).toBe(false);
    expect(error.hidden).toBe(true);
    listeners.get('toggle')!();
    expect(choices.every(choice => choice.checked)).toBe(true);
  });
  it('preserves saved selections and safely escapes names and IDs', () => {
    const html = renderMcpWorkspaceSelection([{ id: 'a"b', name: '<script>alert(1)</script>', publicRoomCount: 0, selected: false }]);
    expect(html).not.toContain(' checked');
    expect(html).toContain('value="a&quot;b"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('id="selection-error" role="status">Select at least one');
    expect(html).not.toContain('<script>');
  });
  it('shows the no-selection guidance for an empty eligible list and uses static progressive enhancement', () => {
    const html = renderMcpWorkspaceSelection([]);
    expect(html).toContain('Select at least one Workspace');
    expect(html).not.toContain('type="checkbox"');
    expect(MCP_WORKSPACE_SCRIPT).toContain('allow.disabled = count === 0');
    expect(MCP_WORKSPACE_SCRIPT).toContain("choice.addEventListener('change', update)");
    expect(MCP_WORKSPACE_SCRIPT).not.toContain('innerHTML');
  });
});
