# Corner Apps

A Corner App is installed in a Workspace and optionally bound to one corner instance when that corner is created. Apps are not generated inside corners.

The version 1 manifest keeps two capabilities separate:

- `humanUi` declares either a native Beeline definition or an opaque broker capability.
- `agent` declares an opaque broker capability for agent tools.
- `permissions` names the grants either capability may request. A manifest is a declaration, not permission.

```json
{
  "version": 1,
  "slug": "release-board",
  "title": "Release board",
  "developer": "Example developer",
  "humanUi": {
    "kind": "broker",
    "capability": "release-board.ui"
  },
  "agent": {
    "kind": "broker",
    "capability": "release-board.agent"
  },
  "permissions": ["github.read"]
}
```

Native human UI uses the bounded `CornerAppDefinition` vocabulary. Broker capabilities remain opaque until a permissioned app broker is connected; clients must not treat capability names as URLs or executable code.

A selected app always owns the entire corner surface. Set `humanUi.embedsChat` only when the app intentionally includes chat within that app surface; Beeline does not add a separate or default Chat tab.
