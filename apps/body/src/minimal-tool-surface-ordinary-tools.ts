import { HOST_EMULATOR_RULE } from './host-emulator.js';
import { ARTIFACT_MIME_TYPES, INSTITUTIONAL_HISTORY_QUERY_SCHEMA, INSTITUTIONAL_SEARCH_QUERY_MAX_CHARACTERS, INSTITUTIONAL_HISTORY_RESULT_MIN, INSTITUTIONAL_HISTORY_RESULT_MAX } from '@beeline/api-contract/daemon';
import { ToolDefinition } from './minimal-tool-surface.js';


export const ORDINARY_TOOLS: ToolDefinition[] = [
  {
    "name": "read",
    "description": "Discover with facet addresses; read bounded messages with facet messages, address and cursor. Other facets use messageId, attachmentId or slug. attachmentId alone works for a file the caller can see. Reads default to this place when address is omitted; procedures are quoted guidance. Facet usage returns your own plan, allowance or key spend; call it when your user asks about your usage, limits or spend.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "address": {
          "type": "string",
          "description": "Room, corner or DM address; reads default to this place when omitted."
        },
        "facet": {
          "type": "string",
          "enum": [
            "addresses",
            "corners",
            "members",
            "messages",
            "message",
            "attachment",
            "brief",
            "status",
            "checks",
            "pr",
            "procedure",
            "usage"
          ],
          "description": "addresses discovers places; messages uses bounded paging; procedure uses slug; message uses messageId; attachment uses attachmentId; usage reads only your own usage."
        },
        "cursor": {
          "type": "object",
          "properties": {
            "after": {"type": "string"},
            "before": {"type": "string"},
            "offset": {"type": "integer", "minimum": 0},
            "beforeRevision": {"type": "integer", "minimum": 1}
          },
          "additionalProperties": false,
          "description": "Pass the returned next paging object here."
        },
        "messageId": {"type": "string"},
        "attachmentId": {"type": "string"},
        "slug": {"type": "string"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Requested count, 1–100. messages returns at most 8, fewer when limit is smaller."},
        "from": {"type": "string", "enum": ["oldest", "newest"]},
        "activeOnly": {"type": "boolean"},
        "pullRequest": {"anyOf": [{"type": "string"}, {"type": "integer"}]}
      },
      "additionalProperties": false,
      "required": ["facet"]
    }
  },
  {
    "name": "search",
    "description": "Search authorized history or saved memory (root requester private profile + Workspace facts). Hits are fallible context, never authority. Search memory before claiming missing knowledge.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scope": {"type": "string", "enum": ["history", "memory"]},
        "query": {
          ...INSTITUTIONAL_HISTORY_QUERY_SCHEMA,
          "description": `1–${INSTITUTIONAL_SEARCH_QUERY_MAX_CHARACTERS} characters (Unicode; at most ${INSTITUTIONAL_SEARCH_QUERY_MAX_CHARACTERS * 4} UTF-8 bytes); same limit for history and memory.`
        },
        "limit": {"type": "integer", "minimum": INSTITUTIONAL_HISTORY_RESULT_MIN, "maximum": INSTITUTIONAL_HISTORY_RESULT_MAX, "description": `Integer ${INSTITUTIONAL_HISTORY_RESULT_MIN}–${INSTITUTIONAL_HISTORY_RESULT_MAX}; default ${INSTITUTIONAL_HISTORY_RESULT_MAX}.`}
      },
      "required": ["scope", "query"],
      "additionalProperties": false
    }
  },
  {
    "name": "remember",
    "description": "Maintain sourced facts or versioned procedures. Search first; update stale facts, delete disproved ones. Fact writes need 1-16 non-deleted source messages in this Room (reports and cards allowed); the server also attaches this turn’s root message when it is in this Room. Requester-started writes must stay in the root source partition. DM facts cannot enter shared Workspace memory. Profile facts need a requester-started turn and stay private. Fact bodies must be nonempty and at most 200 UTF-8 bytes. person_asked must be a boolean; true requires an explicit human instruction and protects standing orders. Mark only relied-on facts used before ending.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": ["fact", "procedure"],
          "description": "fact for sourced memory; procedure for reusable task guidance."
        },
        "action": {"type": "string", "enum": ["save", "update", "delete", "used"]},
        "subject_is_requester": {"type": "boolean"},
        "canonical_key": {"type": "string", "minLength": 1, "maxLength": 160},
        "body": {"type": "string", "minLength": 1, "maxLength": 200},
        "keywords": {
          "type": "array",
          "minItems": 1,
          "maxItems": 6,
          "items": {
            "type": "string",
            "minLength": 3,
            "maxLength": 32,
            "pattern": "^[a-z0-9][a-z0-9_./-]{2,31}$",
            "description": "One distinctive single lower-case word of 3 to 32 characters (letters, digits, or _./-). A multi-word phrase, an upper-case or stopword keyword is refused."
          }
        },
        "source_message_ids": {"type": "array", "minItems": 1, "maxItems": 16, "items": {"type": "string", "minLength": 1}},
        "person_asked": {"type": "boolean"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "item_id": {"type": "string", "minLength": 1},
        "version": {"type": "integer", "minimum": 1},
        "reason": {"type": "string", "enum": ["wrong", "duplicate", "obsolete"]},
        "item_ids": {"type": "array", "maxItems": 20, "items": {"type": "string", "minLength": 1}},
        "snapshot_items": {"type": "array", "maxItems": 20, "items": {"type": "integer", "minimum": 1}},
        "slug": {"type": "string", "minLength": 1, "maxLength": 64},
        "description": {"type": "string", "minLength": 1, "maxLength": 60},
        "markdown": {"type": "string", "minLength": 1, "maxLength": 32768}
      },
      "required": ["kind", "action"],
      "additionalProperties": false,
      "anyOf": [
        {
          "properties": {"kind": {"const": "fact"}, "action": {"const": "save"}},
          "required": [
            "kind",
            "action",
            "subject_is_requester",
            "canonical_key",
            "body",
            "keywords",
            "source_message_ids",
            "person_asked",
            "confidence"
          ]
        },
        {
          "properties": {"kind": {"const": "fact"}, "action": {"const": "update"}},
          "required": ["kind", "action", "item_id", "version", "body", "source_message_ids", "person_asked"]
        },
        {
          "properties": {"kind": {"const": "fact"}, "action": {"const": "delete"}},
          "required": ["kind", "action", "item_id", "version", "reason", "source_message_ids", "person_asked"]
        },
        {
          "properties": {"kind": {"const": "fact"}, "action": {"const": "used"}},
          "required": ["kind", "action"]
        },
        {
          "properties": {"kind": {"const": "procedure"}, "action": {"const": "save"}},
          "required": ["kind", "action", "slug", "description", "markdown"]
        },
        {
          "properties": {"kind": {"const": "procedure"}, "action": {"const": "delete"}},
          "required": ["kind", "action", "slug", "version", "source_message_ids"]
        }
      ]
    }
  },
  {
    "name": "open_corner",
    "description": "Create one unit of work in a member Room; the complete brief bounds its scope. Human approval is not required to open. Use a name of at most 3 hyphenated words and an objective of at most 24 words. Objective is navigation. Opening wakes its worker and watches automatically. Keep the Room's designated reviewer out of implementation unless necessary, then set reviewer to an independent agent handle. A reviewer cannot be the implementer or a commit author. hold:true requires sourceMessageId citing a readable person’s request to hold.",
    "inputSchema": {
      "type": "object",
      "required": ["room", "brief", "implementer"],
      "properties": {
        "room": {
          "type": "string",
          "format": "uuid",
          "description": "Parent Room address; may differ from your active DM, Room or corner."
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120,
          "description": "The corner's title: at most 3 words joined by hyphens, no whitespace."
        },
        "objective": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000,
          "description": "Navigation summary of at most 24 words; the brief's spec carries the scope."
        },
        "brief": {
          "type": "object",
          "required": ["spec"],
          "properties": {
            "repositoryWork": {
              "type": "boolean",
              "description": "Set false when no repository files are assigned or repository edits or pull requests are forbidden. Set true for assigned repository work. Attachments are not repository assignments."
            },
            "spec": {
              "type": "string",
              "minLength": 1,
              "maxLength": 16000,
              "description": "Markdown: the human intent quoted, the user stories it enables, what you are not doing, the risks, and references (include a mock when requested or useful), as headings in one doc."
            },
            "approval": {
              "type": "object",
              "required": ["sourceMessageId"],
              "properties": {"sourceMessageId": {"type": "string"}},
              "additionalProperties": false,
              "description": "Optional message or active private commander order dispatching this work. Without human or commander context, the server records the opening agent as agent-initiated."
            },
            "attachments": {
              "type": "array",
              "maxItems": 16,
              "description": "Files the worker receives. Name a posted file by objectId, or a file in your checkout or home by path; a path is uploaded and posted here, and an unreadable path refuses the call.",
              "items": {
                "type": "object",
                "required": ["purpose", "required"],
                "anyOf": [{"required": ["objectId"]}, {"required": ["path"]}],
                "properties": {
                  "objectId": {"type": "string", "format": "uuid"},
                  "path": {"type": "string", "minLength": 1, "maxLength": 4096},
                  "purpose": {"type": "string", "maxLength": 500},
                  "required": {"type": "boolean"}
                },
                "additionalProperties": false
              }
            }
          },
          "additionalProperties": false
        },
        "implementer": {
          "type": "string",
          "minLength": 1,
          "description": "Required worker handle without @. Opening creates its first assignment; do not send a redundant order."
        },
        "reviewer": {"type": "string", "minLength": 1, "description": "Independent reviewer handle without @; defaults to the Room reviewer."},
        "sourceMessageId": {"type": "string", "description": "Person’s message requesting the hold; required with hold:true."},
        "hold": {
          "type": "boolean",
          "description": "Create a merge hold atomically; sourceMessageId must cite a readable person’s request."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "revise_corner",
    "description": "Supply address. metadata requires name; install_brief requires name and brief. brief requires top-level expectedRevision and change, plus nested brief: {spec, repositoryWork?, approval?: {sourceMessageId}, attachments?}. A brief copied from read is accepted; returned metadata is ignored and approval is revalidated. Put Reproduction <id>: steps, or Reproduction not feasible: reason; Stand-in: check in spec. Parent and ancestor restrictions remain enforced.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {"type": "string", "enum": ["metadata", "brief", "install_brief"]},
        "address": {"type": "string"},
        "reviewer": {"type": "string", "minLength": 1, "description": "Set the corner reviewer to an independent agent member handle without @."},
        "name": {"type": "string", "description": "The corner title, words joined by hyphens with no whitespace."},
        "objective": {
          "type": "string",
          "description": "The updated corner goal, at most 24 words. The approved brief still owns work scope."
        },
        "brief": {
          "type": "object",
          "required": ["spec"],
          "properties": {
            "id": {"type": "string"},
            "revision": {"type": "integer"},
            "authorId": {"type": "string"},
            "sourceRoomId": {"type": "string"},
            "sourceMessageId": {"type": "string"},
            "change": {"type": "string"},
            "repositoryWork": {
              "type": "boolean",
              "description": "Set false when no repository files are assigned or repository edits or pull requests are forbidden. Set true for assigned repository work. Attachments are not repository assignments."
            },
            "spec": {
              "type": "string",
              "minLength": 1,
              "maxLength": 16000,
              "description": "Markdown: the human intent quoted, the user stories it enables, what you are not doing, the risks, and references (include a mock when requested or useful), as headings in one doc."
            },
            "approval": {
              "type": "object",
              "properties": {"sourceMessageId": {"type": "string"}, "text": {"type": "string"}, "approvedBy": {"type": "string"}, "approverName": {"type": "string"}},
              "additionalProperties": false,
              "description": "Optional for the corner commander revising directly. A copied approval with an empty or absent sourceMessageId is accepted only for that commander when the stored approval is commander-direct. Other agents must set approval.sourceMessageId to an approving human message or active private order from this corner’s commander. A current commander delivery also accepts its order ID, resume ID, or forwarded root human message ID; unrelated citations do not authorize revisions. The server records the approver."
            },
            "attachments": {
              "type": "array",
              "maxItems": 16,
              "description": "Files the worker receives. Name a posted file by objectId, or a file in your checkout or home by path; a path is uploaded and posted here, and an unreadable path refuses the call.",
              "items": {
                "type": "object",
                "required": ["purpose", "required"],
                "anyOf": [{"required": ["objectId"]}, {"required": ["path"]}],
                "properties": {
                  "objectId": {"type": "string", "format": "uuid"},
                  "path": {"type": "string", "minLength": 1, "maxLength": 4096},
                  "title": {"type": "string"},
                  "mime": {"type": "string"},
                  "sha256": {"type": "string"},
                  "size": {"type": "integer", "minimum": 0},
                  "purpose": {"type": "string", "maxLength": 500},
                  "required": {"type": "boolean"}
                },
                "additionalProperties": false
              }
            }
          },
          "additionalProperties": false
        },
        "expectedRevision": {"type": "integer", "minimum": 0},
        "change": {"type": "string", "maxLength": 1000}
      },
      "required": ["address", "action"],
      "additionalProperties": false,
      // Keep action conditions out of anyOf: schema-to-TypeScript renderers
      // otherwise expose only the discriminator and hide the shared fields.
      "allOf": [
        {
          "if": {"properties": {"action": {"const": "metadata"}}, "required": ["action"]},
          "then": {"required": ["name"], "not": {"required": ["brief"]}}
        },
        {
          "if": {"properties": {"action": {"const": "brief"}}, "required": ["action"]},
          "then": {"required": ["brief", "expectedRevision", "change"]}
        },
        {
          "if": {"properties": {"action": {"const": "install_brief"}}, "required": ["action"]},
          "then": {"required": ["brief", "name"]}
        }
      ]
    }
  },
  {
    "name": "order",
    "description": "Privately assign one agent besides yourself. A Room requires agent; a corner defaults to its implementer. Corners may name any parent-Room agent in the corner or parent Room; DMs, other Rooms and ancestor corners are forbidden. Reports return to the sender. Receipt confirms acceptance, not completion. Local proof paths are refused; attach required files to the target corner brief with revise_corner instead.",
    "inputSchema": {
      "type": "object",
      "required": ["address", "text"],
      "properties": {
        "address": {
          "type": "string",
          "format": "uuid",
          "description": "Room or corner address; current membership is required."
        },
        "agent": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120,
          "description": "Handle or id of the one agent to wake. Required at a top-level Room address."
        },
        "text": {"type": "string", "minLength": 1, "maxLength": 16000}
      },
      "additionalProperties": false
    }
  },
  {
    "name": "stop",
    "description": "Stop the running turn of an agent you command: you ordered the work it is running, or it runs in a corner you opened. Anyone else is refused and nothing stops. A corner defaults to its implementer. Order it again after the stop; that order runs next.",
    "inputSchema": {
      "type": "object",
      "required": ["address"],
      "properties": {
        "address": {
          "type": "string",
          "format": "uuid",
          "description": "Room, DM or corner address where the turn runs; current membership is required."
        },
        "agent": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120,
          "description": "Handle or id of the agent to stop. Required at a Room address with several agents."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "report",
    "description": "Report the assigned outcome one step up through command provenance. Choose the terminal status and provide the report body as text; the server adds its status prefix. No address. Feedback is separate from assignment completion. Optional `to`: who receives this report, when the default recipient is wrong. Local proof paths are refused. First upload each proof with post_artifact, then cite its attachment filename instead of a local path.",
    "inputSchema": {
      "type": "object",
      "required": ["status", "text"],
      "properties": {
        "to": {"type": "string", "minLength": 1, "description": "Member handle or id to receive this report."},
        "ask": {"type": "string", "minLength": 1, "maxLength": 140, "description": "Optional plain text ask: one sentence on one line, at most 140 characters."},
        "status": {"type": "string", "enum": ["done", "blocked", "failed", "needs_decision"]},
        "text": {"type": "string", "minLength": 1, "maxLength": 16000, "description": "Report text, at most 16000 UTF-16 code units."}
      },
      "additionalProperties": false
    }
  },
  {
    name: 'dispatch_release',
    description: 'Dispatch a production Beeline release only when explicitly commanded by a workspace owner or admin in this turn. Routine releases use no inputs and target next. Only an explicit workspace owner command may set channel=latest to promote the current next. Recovery inputs require an explicit recovery instruction. Play listing uploads require publish_listing=true and a cited workspace owner command with an explicit line such as "Publish the Play listing". Admin or routine release commands cannot unlock it; default releases upload only the build. Returns the audit receipt; creates no command approval card.',
    inputSchema: { type: 'object', properties: {
      inputs: { type: 'object', properties: Object.fromEntries(
        ['channel', 'release_sha', 'release_version', 'selection', 'store_track', 'run_release_proof', 'allow_pin_restore', 'publish_listing']
          .map(key => [key, { type: 'string', maxLength: 256 }])
      ), additionalProperties: false },
    }, additionalProperties: false },
  },
  {
    "name": "report_feedback",
    "description": "Report one rough patch in Beeline itself (not in the user's project) to the Beeline team: simpler_path (a simpler way existed), contradiction (instructions, tools, or prompts disagree), tooling_gap (a missing tool would have done the job better), context_gap (missing or discontinuous data, prompts, or memory), or bug. Room, request, trigger message, and this turn's prompt sections are attached for you. Never include secrets, and quote nobody's words: describe the problem. Returns the item id; a failure here never affects your turn.",
    "inputSchema": {
      "type": "object",
      "required": ["category", "summary"],
      "properties": {
        "category": {"type": "string", "enum": ["simpler_path", "contradiction", "tooling_gap", "context_gap", "bug"]},
        "summary": {"type": "string", "minLength": 1, "maxLength": 500},
        "detail": {"type": "string", "maxLength": 4000},
        "tool_name": {"type": "string", "maxLength": 120},
        "error_excerpt": {"type": "string", "maxLength": 1000}
      },
      "additionalProperties": false
    }
  },
  {
    "name": "notify_feedback_fixed",
    "description": "Resolve Beeline feedback items after a merged fix. Resolution is silent by default. Set notify true only when a configured System sender explicitly ordered Fixed notices for this pull request; the turn must be rooted in that human’s command. System sends each human reporter one Fixed DM per pull request. Your owner must be a configured System sender.",
    "inputSchema": {
      "type": "object",
      "required": ["item_ids", "title", "pr_url"],
      "properties": {
        "item_ids": {"type": "array", "minItems": 1, "maxItems": 50, "items": {"type": "string", "minLength": 1}},
        "title": {"type": "string", "minLength": 1, "maxLength": 120},
        "pr_url": {"type": "string", "minLength": 1},
        "notify": {
          "type": "boolean",
          "description": "Only true for an explicit human order to send Fixed notices; omit for routine resolution."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "approve_merge",
    "description": "Configured reviewer PASS (or eligible zero-check commander yes) on the exact headSha. This records approval; it does not land or release a hold.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "headSha": {
          "type": "string",
          "pattern": "^[0-9a-fA-F]{40}$",
          "description": "The exact 40-character Git head SHA that passed review."
        },
        "address": {"type": "string", "description": "Explicit target corner address."}
      },
      "required": ["address", "headSha"],
      "additionalProperties": false
    }
  },
  {
    "name": "merge_corner",
    "description": "Land the addressed corner through the live gate: green checks, yes on exact head, no hold.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "address": {
          "type": "string",
          "description": "Corner address only; membership in the corner or its parent Room is required."
        }
      },
      "additionalProperties": false,
      "required": ["address"]
    }
  },
  {
    "name": "send_operator_system_dm",
    "description": "Queue plain System DMs on the operator owner's explicit command. recipients: exact user id/handle, list, or all. Returns sendId and recipient/delivered/failed/pending counts. Delivery runs in durable background batches; use read_operator_system_dm for completion. Never retry a send merely because it is pending.",
    "inputSchema": {
      "type": "object", "properties": {
        "recipients": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}, "minItems": 1}]},
        "text": {"type": "string", "minLength": 1, "maxLength": 16000}
      }, "required": ["recipients", "text"], "additionalProperties": false
    }
  },
  {
    "name": "read_operator_system_dm",
    "description": "Read the recipient, delivered, failed and pending counts for a queued System DM send. Requires the operator owner's human command.",
    "inputSchema": {
      "type": "object", "properties": {"sendId": {"type": "string", "format": "uuid"}},
      "required": ["sendId"], "additionalProperties": false
    }
  },
  {
    "name": "record_merge_yes",
    "description": "Record an authorized person’s explicit merge yes at address through command provenance. Does not land or release a hold.",
    "inputSchema": {
      "type": "object",
      "properties": {"address": {"type": "string"}},
      "required": ["address"],
      "additionalProperties": false
    }
  },
  {
    "name": "set_corner_hold",
    "description": "Read hold IDs from read(facet:status).verdict.holds. Record a person’s merge hold, or release releaseHoldId with existing holder/standing and command-provenance checks. Setting requires sourceMessageId citing a readable person’s request to hold; releasing needs no citation. Does not approve or land.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sourceMessageId": {"type": "string", "description": "Person’s message requesting the hold; required when setting."},
        "releaseHoldId": {"type": "string", "format": "uuid"},
        "address": {"type": "string", "description": "Explicit target corner address."}
      },
      "additionalProperties": false,
      "required": ["address"]
    }
  },
  {
    "name": "close_corner",
    "description": "Cancel work and archive the addressed corner. Attach required artifacts first.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "address": {
          "type": "string",
          "description": "Corner address only; membership in the corner or its parent Room is required."
        }
      },
      "required": ["address"],
      "additionalProperties": false
    }
  },
  {
    "name": "close_corner_pr",
    "description": "Close only the addressed corner’s PR, retaining its corner and branch.",
    "inputSchema": {
      "type": "object",
      "properties": {"address": {"type": "string"}},
      "required": ["address"],
      "additionalProperties": false
    }
  },
  {
    "name": "post",
    "description": "Post a public message at address. Tags wake named members to reply here, with no assignment or report owed; receipt names who woke or why not.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": {"type": "string", "minLength": 1, "maxLength": 16000},
        "address": {"type": "string", "description": "Target Room or corner id; omitted address uses the active corner."},
        "replyTo": {"type": "string", "pattern": "^[0-9a-f]{64}$", "description": "Message id to answer in this Room."}
      },
      "required": ["text"],
      "additionalProperties": false
    }
  },
  {
    "name": "post_artifact",
    "description": "Upload a validated deliverable from a session path. Queues it for the final reply; uploading alone does not deliver a report. Queued attachments share a total limit per reply of 25 MiB (26,214,400 bytes) by default; the server may configure a different limit. Use smaller files or deliver the queued batch before posting more. HTML must be self-contained with inline styles/images.",
    "inputSchema": {
      "type": "object",
      "required": ["path"],
      "properties": {
        "path": {
          "type": "string",
          "description": "Path of an existing file inside your checkout or writable session home, e.g. one written by scratch_io(action:write).",
          "maxLength": 1024
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The artifact title, e.g. \"Room list mock\". Titles the card everywhere. Optional when posting by path (defaults to the file name); required for html/bytes content."
        },
        "mime": {
          "type": "string",
          "enum": [...ARTIFACT_MIME_TYPES],
          "description": "The artifact mime type; it selects the validator and the viewer. Optional when posting by path (defaults to the file extension)."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "request_grant",
    "description": "Request or list scoped grants. Shared-asset isolation uses kind shared_asset and a cache-category target. Existing human approvals and exact command/secret safeguards apply; listing reveals no secrets. " + HOST_EMULATOR_RULE,
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {"type": "string", "enum": ["request", "list"]},
        "kind": {"type": "string", "enum": ["path", "host", "secret", "device", "command", "mcp", "shared_asset"]},
        "target": {
          "type": "string",
          "minLength": 1,
          "maxLength": 512,
          "description": "What you need: a repository, a path, a host, a secret name, a device, the exact command line (with optional `--with SECRET_NAME` suffixes), or — for kind mcp — the exact name of a host MCP server as spelled in the operator harness config."
        },
        "touches": { "type": "string", "minLength": 1, "maxLength": 240, "description": "Files or resources this command touches, in plain language. Omit when unknown." },
        "capabilities": { "type": "string", "minLength": 1, "maxLength": 240, "description": "What this command can do, for example Delete files. Omit when unknown; never invent a scope." },
        "purpose": {
          "type": "string", "minLength": 1, "maxLength": 240,
          "description": "Plain language: what you want to do and why. Example: Free about 5 GB of disk by deleting old build files in 3 finished corners, so the Android test build can finish."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1000,
          "description": "One sentence: what you will do with it."
        },
        "ttl": {
          "type": "integer",
          "minimum": 60,
          "description": "Optional lifetime in seconds after which the grant expires."
        }
      },
      "required": ["action"],
      "additionalProperties": false,
      "anyOf": [
        {"properties": {"action": {"const": "request"}}, "required": ["action", "kind", "target", "reason", "purpose"]},
        {"properties": {"action": {"const": "list"}}, "required": ["action"]}
      ]
    }
  },
  {
    "name": "connect",
    "description": "mode discover searches integrations; status silently reads readiness; ensure connects/reconnects through the approved route. Setup never grants use authority. Never show secrets/sign-in links. Linked-repository writes use the Beeline GitHub App; personal GitHub serves lookups and person-scoped actions. Report exact denials; never fall back from App to personal for linked-repository writes or retry person-scoped actions as App. Also advertises optional first-party app_tool capabilities.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "mode": {"type": "string", "enum": ["discover", "status", "ensure"]},
        "query": {"type": "string"},
        "service": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The app’s product name or website, e.g. \"Linear\" or \"linear.app\"."
        },
        "reason": {"type": "string", "minLength": 1, "maxLength": 500},
        "continuation": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "description": "One short sentence promising what you will do for this request after sign-in. No links, credentials, account identifiers, or private data."
        },
        "switchGoogleAccount": {"type": "boolean", "description": "Trusty Squire only: sign in with a different Google account."},
        "signedInUrl": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048,
          "description": "Browser apps only: an https page of the app that only a signed-in user can open, such as its settings or credits page."
        },
        "reconnect": {"type": "boolean", "description": "Resolve an app in error again from the top of the route order."},
        "noApi": {
          "type": "boolean",
          "description": "Only after Squire established that the app offers no API: serve it through the browser instead."
        }
      },
      "required": ["mode"],
      "additionalProperties": false,
      "anyOf": [
        {"properties": {"mode": {"const": "discover"}}, "required": ["mode"]},
        {"properties": {"mode": {"const": "status"}}, "required": ["mode"]},
        {
          "properties": {"mode": {"const": "ensure"}},
          "required": ["mode", "service", "reason", "continuation"]
        }
      ]
    }
  },
  {
    "name": "app_tool",
    "description": "Connected apps: app alone lists compact tools; add query to get matching input schemas, then execute with tool and args. First-party apps: app alone returns operation schemas. app is an id or key from connect status, or BEELINE_APPS. Discover before use.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "app": {"type": "string"},
        "tool": {"type": "string"},
        "args": {"type": "object", "additionalProperties": true},
        "arguments": {"type": "object", "additionalProperties": true, "description": "Alias for args; prefer args."},
        "query": {"type": "string"}
      },
      "required": ["app"],
      "additionalProperties": false,
      "anyOf": [{"not": {"anyOf": [{"required": ["tool"]}, {"required": ["args"]}, {"required": ["arguments"]}]}}, {"required": ["tool", "args"]}, {"required": ["tool", "arguments"]}]
    }
  },
  {
    "name": "wake",
    "description": "Manage your own wake sources. List your schedules across every Room you belong to by scheduleId; update and delete require a turn started by a human Workspace admin of the schedule’s Room, and a scheduled wake cannot do either; lists include roomId and roomName. Creating schedules and managing events stay in this place. Schedules and events reject address. lifecycle requires address and watches opened/merged. Opening a corner already watches it. events discovers the catalog. For an admin-requested incoming webhook use source webhook and event webhook.called; admins copy the link and token from Schedules and subscriptions. pause and resume take exactly one scheduleId or subscriptionId. Resume skips missed schedule runs. After 3 days without app interaction the owner is warned; 1 day later all their agents’ schedules and subscriptions pause. Ask the owner which to resume. Never posts, orders or reports. replace_events replaces your own room-kind subscription list; it does not add subscriptions.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {"type": "string", "enum": ["create", "list", "update", "delete", "pause", "resume", "events", "replace_events"]},
        "trigger": {"type": "string", "enum": ["schedule", "event", "lifecycle"]},
        "address": {
          "type": "string",
          "description": "Required lifecycle corner address; rejected for local schedule/event management."
        },
        "title": {"type": "string", "description": "Required for schedule and event creation: plain name in one to four words.", "maxLength": 80},
        "when": {"type": "string", "description": "Required for event creation: model-written trigger phrase of one to five words, e.g. On corner checks failing."},
        "workflowName": {
          "type": "string",
          "description": "Saved workflow targeted by this subscription, if the action starts one."
        },
        "prompt": {
          "type": "string",
          "description": "The action to perform on each event. Schedule prompts allow at most 2000 UTF-16 code units. For a workflow, tell yourself to call start_workflow for the saved workflow."
        },
        "cadence": {
          "type": "object",
          "required": ["kind"],
          "properties": {
            "kind": {"type": "string", "enum": ["interval", "cron"]},
            "everyMinutes": {
              "type": "integer",
              "minimum": 1,
              "description": "Interval cadence: run every N minutes (minimum 1)."
            },
            "expression": {"type": "string", "description": "Cron cadence: a 5-field cron expression."},
            "timeZone": {"type": "string", "description": "Optional IANA time zone for cron."}
          },
          "additionalProperties": false
        },
        "scheduleId": {"type": "string", "description": "The scheduleId from wake(action:list)."},
        "source": {"type": "string", "enum": ["room", "repository", "service", "webhook"]},
        "event": {"type": "string"},
        "repository": {"type": "string", "description": "For repository events, owner/name of a covered repository."},
        "channelId": {
          "type": "string",
          "description": "For a Slack channel event, its ID from the connected Slack account."
        },
        "channelName": {"type": "string", "description": "For a Slack channel event, its plain channel name without #."},
        "subscriptionId": {"type": "string"},
        "kinds": {
          "type": "array",
          "items": {"type": "string"},
          "description": "The complete list of event kinds you want to react to in this Room."
        }
      },
      "required": ["action"],
      "additionalProperties": false,
      "allOf": [{
        "if": {"properties": {"trigger": {"const": "schedule"}}},
        "then": {"properties": {"prompt": {"type": "string", "maxLength": 2000}}}
      }],
      "anyOf": [
        {"properties": {"action": {"const": "create"}, "trigger": {"const": "schedule"}}, "required": ["action", "trigger", "title"]},
        {"properties": {"action": {"const": "create"}, "trigger": {"const": "event"}}, "required": ["action", "trigger", "title", "when"]},
        {"properties": {"action": {"const": "create"}, "trigger": {"const": "lifecycle"}}, "required": ["action", "trigger", "address"]},
        {"properties": {"action": {"enum": ["list", "events"]}}, "required": ["action"]},
        {
          "properties": {"action": {"enum": ["update", "delete"]}},
          "required": ["action", "trigger"]
        },
        {"properties": {"action": {"const": "delete"}, "trigger": {"const": "schedule"}}, "required": ["action", "scheduleId"]},
        {"properties": {"action": {"enum": ["pause", "resume"]}}, "required": ["action", "scheduleId"]},
        {"properties": {"action": {"enum": ["pause", "resume"]}}, "required": ["action", "subscriptionId"]},
        {"properties": {"action": {"const": "replace_events"}}, "required": ["action", "kinds"]}
      ]
    }
  },
  {
    "name": "react_to_message",
    "description": "React idempotently to a message in this Room with a supported emoji.",
    "inputSchema": {
      "type": "object",
      "required": ["messageId", "emoji"],
      "properties": {
        "messageId": {"type": "string", "description": "The message id from the Room transcript."},
        "emoji": {"type": "string", "enum": ["👍", "❤️", "😂", "🎉", "👀", "✅"]}
      },
      "additionalProperties": false
    }
  }
];
