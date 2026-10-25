"""Count the actual mounted native fixture rows; accepts a raw or gzipped tree."""
import collections
import gzip
import hashlib
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
tree = json.loads(gzip.decompress(source.read_bytes()) if source.suffix == '.gz' else source.read_bytes())


def walk(node):
    yield node
    for child in node['children']:
        yield from walk(child)


nodes = list(walk(tree['tree']))
rows = []
for kind in ['plain-header', 'plain-grouped', 'markdown', 'attachment', 'card', 'system']:
    message_id = hashlib.sha256(('transcript-speed-v1:native-row-count:' + kind).encode()).hexdigest()
    content = next((node for node in nodes if node.get('testId') == 'copy-message-' + message_id), None)
    cell = next(node for node in nodes if any(child.get('testId') in [
        'swipe-reply-' + message_id, 'system-line-' + message_id
    ] for child in node['children']))
    # Fabric hoists descendants of non-stacking native wrappers into siblings.
    # The cell, rather than the system-line identifier alone, bounds that row.
    mounted = list(walk(content)) if content else [item for child in cell['children'] for item in walk(child)]
    header = next((node for node in mounted if node.get('testId') == 'chat-byline-profile'), None)
    rows.append({
        'kind': kind, 'id': message_id,
        'contentMountedViews': len(mounted),
        'cellMountedViews': len(list(walk(cell))),
        'headerMountedViews': len(list(walk(header))) if header else 0,
        'classes': dict(collections.Counter(node['class'].split('.')[-1] for node in mounted)),
    })
print(json.dumps(rows, indent=2))
