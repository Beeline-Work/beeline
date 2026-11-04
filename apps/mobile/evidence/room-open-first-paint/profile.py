"""Apply/restore temporary, build-only native profiling hooks in this worktree.

Example: python3 profile.py apply --backup .beeline-proof/room-profile
Always restore before committing. The helper adds no controller/network site.
"""
import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
FILES = [
    'apps/mobile/metro.config.js',
    'apps/mobile/sources/app/_layout.tsx',
    'apps/mobile/sources/app/(app)/beeline/chat/[channelId].tsx',
    'apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx',
    'apps/mobile/sources/app/(app)/beeline/tray.tsx',
]
HELPER = 'apps/mobile/sources/buzz/room-open-profile.ts'
PROBE = '''let rows: unknown[] = [];
setInterval(() => {
  if (!rows.length) return;
  const data = rows;
  rows = [];
  for (let i = 0; i < data.length; i += 6)
    console.warn('[ROOM_PROFILE] ' + JSON.stringify(data.slice(i, i + 6)));
}, 1000);
export function roomOpenProbe(phase: string, fields: Record<string, unknown> = {}) {
  rows.push({phase, t: performance.now(), ...fields});
}
export function profileRoomOpen(id: string, phase: string, actualDuration: number,
  baseDuration: number, startTime: number, commitTime: number) {
  roomOpenProbe('render', {id, renderPhase: phase, actualDuration, baseDuration, startTime, commitTime});
}
'''


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError('Profiling target changed: ' + old[:80])
    return source.replace(old, new, 1)


def instrument():
    result = {name: (REPO / name).read_text() for name in FILES}
    metro, root, route, surface, tray = FILES
    result[metro] = replace_once(result[metro], 'const baseResolveRequest =',
                                "config.cacheVersion += '-room-open-profile-v1';\nconst baseResolveRequest =")
    result[metro] = replace_once(result[metro], "  if (moduleName === 'preact') {", '''  if (/\\/(ReactFabric|ReactNativeRenderer)-prod$/.test(moduleName)) {
    return context.resolveRequest(context, moduleName.replace('-prod', '-profiling'), platform);
  }
  if (moduleName === 'preact') {''')
    result[root] = "import { profileRoomOpen } from '@/buzz/room-open-profile';\n" + replace_once(
        result[root], '  return providers;',
        '  return <React.Profiler id="Root" onRender={profileRoomOpen}>{providers}</React.Profiler>;')
    result[route] = "import { profileRoomOpen } from '@/buzz/room-open-profile';\n" + replace_once(
        result[route], '<RoomSurface session={session} bindingsRef={bindingsRef} />',
        '<React.Profiler id="Room" onRender={profileRoomOpen}><RoomSurface session={session} bindingsRef={bindingsRef} /></React.Profiler>')
    result[surface] = "import { roomOpenProbe } from '@/buzz/room-open-profile';\n" + replace_once(
        result[surface], '  const transcriptMessages = desktopTranscript ? visibleMessages : invertedMessages;',
        '''  const transcriptMessages = desktopTranscript ? visibleMessages : invertedMessages;
  useLayoutEffect(() => { roomOpenProbe('transcript-commit', {count: transcriptMessages.length, roomId: decodedId, newest: transcriptMessages[0]?.id}); }, [transcriptMessages]);''')
    result[surface] = replace_once(result[surface], 'onContentSizeChange={(_width, height) => {',
                                  '''onContentSizeChange={(_width, height) => {
                    if (transcriptMessages.length) roomOpenProbe('content-layout', {count: transcriptMessages.length, height});''')
    result[tray] = "import { roomOpenProbe } from '@/buzz/room-open-profile';\n" + replace_once(
        result[tray], '  const newestClear = pending.at(-1);',
        '''  useLayoutEffect(() => { if (!loading && !workspaceLost) { const commitAt = performance.now(); const fields = {saved: visibleBookmarks.length, needs: visibleNeeds.length, commitAt}; roomOpenProbe('tray-commit', fields); requestAnimationFrame(() => roomOpenProbe('tray-frame', fields)); } }, [loading, workspaceLost, visibleBookmarks, visibleNeeds]);
  const newestClear = pending.at(-1);''')
    result[HELPER] = PROBE
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['apply', 'restore'])
    parser.add_argument('--backup', type=Path, required=True)
    args = parser.parse_args()
    backup = args.backup.resolve()
    if not backup.is_relative_to(REPO):
        parser.error('Keep profiling backups inside this worktree.')
    if args.action == 'apply':
        if (backup / 'manifest.json').exists() or (REPO / HELPER).exists():
            parser.error('Profiling is already applied; restore first.')
        transformed = instrument()  # Validate every target before writing.
        backup.mkdir(parents=True, exist_ok=True)
        for index, name in enumerate(FILES):
            (backup / str(index)).write_bytes((REPO / name).read_bytes())
        (backup / 'manifest.json').write_text(json.dumps(FILES))
        for name, source in transformed.items():
            (REPO / name).write_text(source)
    else:
        files = json.loads((backup / 'manifest.json').read_text())
        if files != FILES:
            parser.error('Backup does not match these profiling targets.')
        for index, name in enumerate(files):
            (REPO / name).write_bytes((backup / str(index)).read_bytes())
        (REPO / HELPER).unlink(missing_ok=True)
        (backup / 'manifest.json').unlink()
    print(args.action + ': native profiling hooks ' + ('installed' if args.action == 'apply' else 'restored'))
