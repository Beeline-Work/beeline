/** Keep eval writes inside their own fixture Room and reject failed tool results. */
const blocked = new Set(['merge_corner', 'approve_merge', 'record_merge_yes', 'dispatch_release', 'run_granted_command', 'order', 'send_operator_system_dm', 'notify_feedback_fixed']);

export function isUnsafeDiscoveryCall(name, args, room) {
    if (name === 'post')
        return !room || (args.address !== undefined && args.address !== room);
    return blocked.has(name) || (name === 'connect' && args.mode === 'ensure') ||
        (name === 'app_tool' && args.tool && !['beeline:workflow', 'beeline:onboarding'].includes(args.app));
}

function errorEnvelope(value) {
    return value && typeof value === 'object' && (value.isError === true || Boolean(value.error));
}

export function discoveryResultSucceeded(result, error) {
    if (!result || error || errorEnvelope(result)) return false;
    return !(result.content ?? []).some(block => {
        if (block.type !== 'text' || typeof block.text !== 'string') return false;
        if (/^\s*daemon operation \S+ failed\b/i.test(block.text)) return true;
        try { return Boolean(errorEnvelope(JSON.parse(block.text))); }
        catch { return false; }
    });
}
