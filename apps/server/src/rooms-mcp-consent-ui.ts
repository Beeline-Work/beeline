/** Workspace rows reuse the consent page's Bone/Obsidian tokens and 44px targets. */
export interface McpConsentWorkspace {
  id: string;
  name: string;
  publicRoomCount: number;
  selected?: boolean;
  alreadyConnected?: boolean;
}
const escape = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export function renderMcpWorkspaceSelection(workspaces: readonly McpConsentWorkspace[]): string {
  return `<fieldset class="workspace-section" aria-labelledby="workspace-heading"><input type="hidden" name="workspace_selection" value="1" form="mcp-consent-form"><div class="workspace-heading"><p class="fine" id="workspace-heading">Workspaces</p><button id="select-all-workspaces" class="edit text-button" type="button" hidden>Select all</button></div><div class="workspace-list">${workspaces.map(workspace => `<label class="workspace"><input type="checkbox" name="workspace_ids" value="${escape(workspace.id)}" form="mcp-consent-form"${workspace.alreadyConnected || workspace.selected !== false ? ' checked' : ''}${workspace.alreadyConnected ? ' disabled' : ''}><span class="workspace-copy"><span>${escape(workspace.name)}</span><span class="meta">${workspace.alreadyConnected ? 'already connected · ' : ''}${workspace.publicRoomCount} public ${workspace.publicRoomCount === 1 ? 'Room' : 'Rooms'}</span></span>${workspace.alreadyConnected ? `<input type="hidden" name="workspace_ids" value="${escape(workspace.id)}" form="mcp-consent-form">` : ''}</label>`).join('')}</div><p class="workspace-help fine">Choose the Workspaces this member can join. New connections start with all selected.</p><p class="fine" id="selection-error" role="status"${workspaces.some(workspace => workspace.alreadyConnected || workspace.selected !== false) ? ' hidden' : ''}>Select at least one Workspace to continue.</p></fieldset>`;
}

export const MCP_WORKSPACE_STYLE = `
[hidden]{display:none!important}.workspace-section{border:0;padding:0;margin:0 0 24px;min-width:0;width:100%}.workspace-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.workspace-heading .fine{margin:0}.text-button{font:inherit;font-size:13px;line-height:19px;background:none;border:0;color:var(--brass);padding:0;cursor:pointer;min-height:44px}.workspace-list{border-top:1px solid var(--border)}.workspace{display:flex;gap:16px;align-items:center;min-height:64px;margin:0;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer;font-weight:400}.workspace:hover{background:var(--raised)}.workspace input{flex:0 0 20px;width:20px;height:20px;margin:0;padding:0;accent-color:var(--brass);cursor:pointer}.workspace-copy{display:flex;flex-direction:column;gap:4px;min-width:0;overflow-wrap:anywhere}.workspace-copy .meta{margin:0}.workspace-help,#selection-error{margin:8px 0 0}.btn:disabled{opacity:.4;cursor:not-allowed}`;

// Static only: workspace names and identifiers never enter executable script.
export const MCP_WORKSPACE_SCRIPT = `
(() => {
  const form = document.getElementById('mcp-consent-form');
  if (!form) return;
  const choices = Array.from(document.querySelectorAll('input[type="checkbox"][name="workspace_ids"]'));
  const editable = choices.filter(choice => !choice.disabled);
  const toggle = document.getElementById('select-all-workspaces');
  const error = document.getElementById('selection-error');
  const allow = form.querySelector('button[value="allow"]');
  if (!toggle || !error || !allow) return;
  const update = () => {
    const count = choices.filter(choice => choice.checked).length;
    allow.disabled = count === 0;
    error.hidden = count > 0;
    toggle.textContent = editable.length > 0 && editable.every(choice => choice.checked) ? 'Deselect all' : 'Select all';
  };
  toggle.hidden = editable.length === 0;
  toggle.addEventListener('click', () => {
    const select = editable.some(choice => !choice.checked);
    editable.forEach(choice => { choice.checked = select; });
    update();
  });
  choices.forEach(choice => choice.addEventListener('change', update));
  update();
})();`;
