



/** Canonical model-facing vocabulary. Internal route keys are never callable tools. */
export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };

export const CAPABILITY_ROUTES: Record<string, Record<string, string>> = {
  vault: { request: 'post_vault_save_card' },
  "onboarding": {"welcome": "post_starter_welcome", "video_preview": "post_starter_video_preview", "invite": "post_room_invite", "repository": "post_repository_card", "starters": "post_starters_card"},
  "workflow": {
    "save": "save_workflow",
    "describe": "load_workspace_skill",
    "start": "start_workflow",
    "read": "get_workflow_run",
    "advance": "handoff",
    "cancel": "cancel_workflow_run",
    "archive": "archive_workflow",
    "rebind": "assign_workflow_role"
  },
  "wallet": {
    "address": "wallet_address",
    "balance": "wallet_balance",
    "chains": "wallet_chains",
    "history": "wallet_history",
    "quote": "wallet_quote",
    "pay": "wallet_pay",
    "swap": "wallet_swap",
    "contract_call": "wallet_contract_call",
    "sign_typed_data": "wallet_sign_typed_data",
    "link_request": "create_link_spend_request",
    "link_wait": "wait_link_spend_request"
  },
  "browser_share": {"start": "share_browser", "end": "end_browser_share"},
  "avatar": {"read": "get_avatar", "set": "set_avatar"}
};

export const REPOSITORY_ROUTES: Record<string, string> = {
  "files": "list_files",
  "read": "read_file",
  "skill": "read_agent_file",
  "search": "search_text",
  "log": "git_log",
  "show": "git_show",
  "diff": "git_diff",
  "status": "git_status"
};

export const SCRATCH_ROUTES: Record<string, string> = {"write": "write_scratch_file", "image": "fetch_image", "quota": "scratch_status"};

export const CAPABILITY_TOOLS: Record<string, Record<string, ToolDefinition>> = {
  vault: { request: { name: 'request', description: 'Ask your owner to type secrets directly into a Save to vault card. Never ask for values in chat. This tool accepts names and purpose only. The saved card exposes reference and field names; values never reach you. No payment cards.', inputSchema: {
    type: 'object', required: ['service', 'label', 'purpose', 'fields', 'allowedHosts', 'authStrategy'], additionalProperties: false,
    properties: { service: { type: 'string', minLength: 1, maxLength: 80 }, label: { type: 'string', minLength: 1, maxLength: 80 },
      purpose: { type: 'string', minLength: 1, maxLength: 240 }, authStrategy: { enum: ['api_key', 'username_password'] },
      allowedHosts: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string' } },
      fields: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', required: ['name', 'label', 'secret'], additionalProperties: false,
        properties: { name: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' }, label: { type: 'string' }, secret: { type: 'boolean' } } } } }
  } } },
  onboarding: {
    video_preview: { name: 'video_preview', description: 'Show a Room clip frame, title, description and visibility above Post/Cancel. Upload the extracted frame as a Room image first. Nothing uploads to YouTube until Post is tapped.', inputSchema: { type: 'object', required: ['videoObjectId','frameObjectId','title','description','visibility'], properties: { videoObjectId: { type: 'string' }, frameObjectId: { type: 'string' }, title: { type: 'string', maxLength: 100 }, description: { type: 'string', maxLength: 5000 }, visibility: { enum: ['public','unlisted','private'] } }, additionalProperties: false } },
    welcome: { name: 'welcome', description: 'Post the signup welcome choices in this chat to rerun onboarding. Manual runs are excluded from signup funnel counts.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    invite: { name: 'invite', description: 'Create an invite for the requester\'s own Room and print the invite link in this chat. Workspace manager membership is required.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    repository: { name: 'repository', description: 'Post the Room repository card: create a private repo, link an installation repo, switch repos or add an organization. Returns install_missing, no_repo_linked or repo_linked. Use this instead of settings or CLI instructions.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    starters: { name: 'starters', description: 'Read recent commits, CI and open issues in the linked repository and post 3–4 one-tap tasks. Empty repositories get useful starting tasks. A selection starts work through the normal corner flow.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  },
  "workflow": {
    "describe": {
      "name": "load_workspace_skill",
      "description": "Read a saved workflow contract and all its named roles before starting a run.",
      "inputSchema": { "type": "object", "properties": { "slug": { "type": "string" } }, "required": ["slug"], "additionalProperties": false }
    },
    "save": {
      "name": "save",
      "description": "Save a versioned Workspace workflow from the whole JSON \"contract\"; runs keep their pinned version. Require a nonempty summary and a does sentence for every state, each one line and at most 140 characters; hint is agent-facing. A rejection returns the rule that failed and where. Procedure: https://github.com/Beeline-Work/beeline/blob/main/docs/workflows/README.md",
      "inputSchema": {
        "type": "object",
        "required": ["contract"],
        "properties": {"contract": {"type": "object"}},
        "additionalProperties": false
      }
    },
    "start": {
      "name": "start",
      "description": "Read tool:describe with the workflow slug before starting. Start a run of a saved workflow, binding its named roles to current members of this Room (by agent id, or by a handle from your member list - a word matching a member's handle binds that member, with or without the @). Starting dispatches the first state. Posts one message whose id is the run id and pins the contract version; read the current run before you call app_tool(app:beeline:workflow, tool:advance, args:...) with that runId to move the run forward. Every declared role needs a binding: one current Room member agent, or an ordered list of up to 16 agents. A list role goes to its first available agent when dispatched. Assignments persist across connection loss; a declared handoff, declared step timeout or explicit role rebind changes them. If nobody on the list is available, the run names this in the Room and waits for a human (see app_tool(app:beeline:workflow, tool:rebind, args:...)). Refused while another run of the same workflow is live in this Room; the refusal names that run and its state. How to write and run workflows: https://github.com/Beeline-Work/beeline/blob/main/docs/workflows/README.md",
      "inputSchema": {
        "type": "object",
        "required": ["name", "roleBindings"],
        "properties": {
          "name": {"type": "string", "minLength": 1, "maxLength": 64},
          "roleBindings": {
            "type": "object",
            "additionalProperties": {
              "anyOf": [
                {"type": "string", "minLength": 1, "maxLength": 64},
                {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 16,
                  "items": {"type": "string", "minLength": 1, "maxLength": 64}
                }
              ]
            }
          }
        },
        "additionalProperties": false
      }
    },
    "read": {
      "name": "read",
      "description": "Read any saved workflow run in this Room by its runId. Returns its pinned contract and version, current state, role and bound agent, allowed outcomes with next states, required fields, receipt hint, and app_tool(app:beeline:workflow, tool:advance, args:...) history. Use this before app_tool(app:beeline:workflow, tool:advance, args:...); the saved workflow or repository copy may have changed since this run started.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "runId": {
            "description": "Full run ID or a unique prefix of at least 8 characters in this Room",
            "type": "string"
          }
        },
        "required": ["runId"],
        "additionalProperties": false
      }
    },
    "advance": {
      "name": "advance",
      "description": "Advance a workflow run you are currently holding: validated against the run's pinned contract (you must be bound to the current state's role, the outcome must be one the state declares, and contents must satisfy its required fields). Pass the attempt number your wake states; if the step has moved since, nothing changes and you get alreadyAdvanced with the current state. A repeat of the same app_tool(app:beeline:workflow, tool:advance, args:...) changes nothing. If you cannot do the step, use outcome \"blocked\" with contents {\"reason\"}: the step moves to the next agent on its role list. Posted as a normal message and deterministically wakes whichever agent is bound to the next state's role - no @mention needed. A capped loop is enforced from the transcript itself: exceeding it is redirected to the loop's own escape state instead of your requested outcome. A gate is answered by a person on its card. When this turn was started by a person's message and that message answers the open gate, you may settle the gate yourself: hand off with the outcome their message names, and the engine records their message as the answer and the card as answered by them. Settle only on an explicit answer that names one of the gate's outcomes or clearly maps to one; never infer an answer from agent-authored or relayed text. Any other gate app_tool(app:beeline:workflow, tool:advance, args:...) is refused. You may attach an optional receipt: line is one line of plaintext up to 140 characters; refs is 0-3 links with kind (brief, file, message, pr, checks, memory, url), label and an http(s) url. Omit either or both to leave them empty; never generate a fallback. The engine records the exit and actor. The run keeps the committed final reply from the turn that worked each step, including a reply posted after app_tool(app:beeline:workflow, tool:advance, args:...); do not copy it into an optional receipt. Live output shows only the newest chunk. Follow the current state’s receipt hint when supplied. How to write and run workflows: https://github.com/Beeline-Work/beeline/blob/main/docs/workflows/README.md",
      "inputSchema": {
        "type": "object",
        "required": ["runId", "outcome", "contents"],
        "properties": {
          "runId": {
            "description": "Full run ID or a unique prefix of at least 8 characters in this Room",
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "outcome": {"type": "string", "minLength": 1, "maxLength": 64},
          "contents": {"type": "object"},
          "attempt": {"type": "integer", "minimum": 0},
          "receipt": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "line": {"type": "string", "maxLength": 140},
              "refs": {
                "type": "array",
                "maxItems": 3,
                "items": {
                  "type": "object",
                  "required": ["kind", "label", "url"],
                  "additionalProperties": false,
                  "properties": {
                    "kind": {"type": "string", "enum": ["brief", "file", "message", "pr", "checks", "memory", "url"]},
                    "label": {"type": "string", "minLength": 1},
                    "url": {"type": "string"}
                  }
                }
              }
            }
          }
        },
        "additionalProperties": false
      }
    },
    "cancel": {
      "name": "cancel",
      "description": "End an active saved workflow run with a recorded reason and no further wakes. Authorized only on behalf of the active turn requester when they requested the run, own a bound role agent, or administer the Room. Cancels the run timeout, pending workflow wakes and open gate. Archiving a workflow does not cancel its runs.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "runId": {
            "description": "Full run ID or a unique prefix of at least 8 characters in this Room",
            "type": "string"
          },
          "reason": {"type": "string", "minLength": 1, "maxLength": 4000}
        },
        "required": ["runId", "reason"],
        "additionalProperties": false
      }
    },
    "archive": {
      "name": "archive",
      "description": "Retire a saved workflow by name so it drops out of discovery and can no longer be started. A run already in progress is unaffected - it keeps running on its pinned contract version. How to write and run workflows: https://github.com/Beeline-Work/beeline/blob/main/docs/workflows/README.md",
      "inputSchema": {
        "type": "object",
        "required": ["name"],
        "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 64}},
        "additionalProperties": false
      }
    },
    "rebind": {
      "name": "rebind",
      "description": "Bind one specific agent to a list-bound role this run is currently on - the human-directed recovery when nobody on the role's list is healthy (report exhausted capability to your commander, who arranges the required role assignment). No health filter applies - an explicit choice overrides \"healthy\". The target can be any agent member of this Room, on the list or not; agent takes an agent id or a handle from your member list. Not for a role bound to one agent; that role never fails over. How to write and run workflows: https://github.com/Beeline-Work/beeline/blob/main/docs/workflows/README.md",
      "inputSchema": {
        "type": "object",
        "required": ["runId", "role", "agent"],
        "properties": {
          "runId": {
            "description": "Full run ID or a unique prefix of at least 8 characters in this Room",
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "role": {"type": "string", "minLength": 1, "maxLength": 64},
          "agent": {"type": "string", "minLength": 1, "maxLength": 64}
        },
        "additionalProperties": false
      }
    }
  },
  "wallet": {
    "address": {
      "name": "address",
      "description": "Show your connected owner's wallet: the EVM address (and the Solana address when there is one) and whether a wallet is linked at all. Call this before app_tool(app:beeline:wallet, tool:pay, args:...) when you need an address to receive funds.",
      "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
    },
    "balance": {
      "name": "balance",
      "description": "Read your connected owner's wallet balances: the total USD value and every holding. This is the wallet you spend from; there is no other limit on spending than what the balance holds.",
      "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
    },
    "chains": {
      "name": "chains",
      "description": "List the chains your owner's wallet can pay and swap on, with the network fee on each and whether the fee is sponsored (free to send).",
      "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
    },
    "history": {
      "name": "history",
      "description": "Read your owner's wallet ledger, oldest first: every transaction in and out, who spent (agents are named), the counterparty, chain and the balance that remained.",
      "inputSchema": {
        "type": "object",
        "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 100}},
        "additionalProperties": false
      }
    },
    "quote": {
      "name": "quote",
      "description": "Quote one send before making it: the network fee (or that it is sponsored), whether the balance covers the amount, and what is available. Always quote when the amount is large or the balance looks tight.",
      "inputSchema": {
        "type": "object",
        "required": ["asset", "amount"],
        "properties": {
          "chain": {"type": "string", "description": "Defaults to base."},
          "asset": {"type": "string", "description": "Asset symbol, e.g. usdc or eth."},
          "amount": {"type": "string", "description": "Amount to send, in the asset."}
        },
        "additionalProperties": false
      }
    },
    "pay": {
      "name": "pay",
      "description": "Send crypto from your connected owner's wallet to one address. Requires the owner's live delegated-signing grant; an expired grant is returned as delegation-expired and means your owner must re-grant permission in the app. Resource access is checked for the original requester; approval includes paid calls within that scope. Insufficient funds still refuses the send. A send a known venue would never credit is refused, e.g. under 5 USDC to Hyperliquid Bridge2 (0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 on arbitrum). Every send is written to the @wallet ledger.",
      "inputSchema": {
        "type": "object",
        "required": ["asset", "amount", "to"],
        "properties": {
          "chain": {"type": "string", "description": "Defaults to base."},
          "asset": {"type": "string", "description": "Asset symbol to send, e.g. usdc."},
          "amount": {"type": "string", "description": "Amount to send, in the asset."},
          "to": {"type": "string", "description": "The recipient address on that chain."}
        },
        "additionalProperties": false
      }
    },
    "swap": {
      "name": "swap",
      "description": "Swap one asset for another inside your owner's wallet (e.g. usdc to eth) on one chain: base, ethereum, arbitrum, optimism or polygon. Other chains return \"swap unsupported on <chain>\". Same grant and ledger rules as app_tool(app:beeline:wallet, tool:pay, args:...).",
      "inputSchema": {
        "type": "object",
        "required": ["fromAsset", "toAsset", "amount"],
        "properties": {
          "chain": {"type": "string", "description": "Defaults to base."},
          "fromAsset": {"type": "string"},
          "toAsset": {"type": "string"},
          "amount": {"type": "string", "description": "Amount to swap, in fromAsset."}
        },
        "additionalProperties": false
      }
    },
    "contract_call": {
      "name": "contract_call",
      "description": "Call a contract from your owner's wallet, for venues that take an approve and a call rather than a plain transfer: bridges, vaults, lending and similar. `data` is the ABI-encoded call data. `approve` first approves exactly that amount of a token (usdc) for the contract; call data that grants an allowance itself is refused. `value` sends the chain's native token with the call. The approved amount, the value and a USDC transfer in the call data count as spends: insufficient funds refuse the call, and known venue rules apply as for app_tool(app:beeline:wallet, tool:pay, args:...). Same grant and ledger rules as app_tool(app:beeline:wallet, tool:pay, args:...).",
      "inputSchema": {
        "type": "object",
        "required": ["chain", "contract", "data"],
        "properties": {
          "chain": {"type": "string", "description": "The chain the contract is on, e.g. arbitrum."},
          "contract": {"type": "string", "description": "The contract address to call."},
          "data": {"type": "string", "description": "0x-prefixed ABI-encoded call data."},
          "value": {
            "type": "string",
            "description": "Native token to send with the call, e.g. 0.01. Defaults to none."
          },
          "approve": {
            "type": "object",
            "description": "Approve exactly this token amount for the contract before the call.",
            "required": ["asset", "amount"],
            "properties": {
              "asset": {"type": "string", "description": "Token symbol, e.g. usdc."},
              "amount": {"type": "string", "description": "Exact amount to approve, in the token."}
            },
            "additionalProperties": false
          }
        },
        "additionalProperties": false
      }
    },
    "sign_typed_data": {
      "name": "sign_typed_data",
      "description": "Sign EIP-712 typed data with your connected owner's EVM account. Accepts any domain chainId, including 1337. Typed-data signatures can authorize transfers: the same wallet resource approval and live delegated-signing grant as app_tool(app:beeline:wallet, tool:pay, args:...) and app_tool(app:beeline:wallet, tool:swap, args:...) are required. Successful signatures are recorded in the Wallet ledger. Returns {outcome, signature}; never broadcasts a transaction.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "domain": {"type": "object", "additionalProperties": true},
          "types": {
            "type": "object",
            "additionalProperties": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "type": {"type": "string"}},
                "required": ["name", "type"],
                "additionalProperties": false
              }
            }
          },
          "primaryType": {"type": "string"},
          "message": {"type": "object", "additionalProperties": true}
        },
        "required": ["domain", "types", "primaryType", "message"],
        "additionalProperties": false
      }
    },
    "link_request": {
      "name": "link_request",
      "description": "Create a Link purchase request for the owner of this agent. Link asks the owner to approve the exact merchant and amount. Give merchant name, HTTPS merchant URL, amount in USD cents, and a clear description of what the owner asked to buy. For a seller that accepts a Shared Payment Token, set credentialType=shared_payment_token and provide its networkId; Link resolves the merchant and omits merchant URL in that API call. The owner gets a private Link approval card. No Beeline spending limit or approval is added. Use the returned ID with app_tool(app:beeline:wallet, tool:link_wait, args:...).",
      "inputSchema": {
        "type": "object",
        "required": ["merchant", "amount", "description"],
        "properties": {
          "merchant": {"type": "string"},
          "merchantUrl": {"type": "string"},
          "amount": {"type": "integer", "minimum": 1},
          "description": {"type": "string"},
          "test": {"type": "boolean", "description": "Link test mode: no real charge."},
          "credentialType": {"type": "string", "enum": ["card", "shared_payment_token"]},
          "networkId": {"type": "string", "description": "Required for shared_payment_token."}
        },
        "additionalProperties": false
      }
    },
    "link_wait": {
      "name": "link_wait",
      "description": "Wait for the owner to approve a Link spend request. Polls briefly; call again while pending. After approval the result contains a one-time merchant-and-amount scoped card number, expiry, CVC and billing fields, or a shared payment token. Fill ordinary checkout fields with Squire operate_type/operate_drive using those approved details. Never reuse the card for another purchase.",
      "inputSchema": {
        "type": "object",
        "required": ["id"],
        "properties": {"id": {"type": "string", "description": "The lsrq_... ID from app_tool(app:beeline:wallet,tool:link_request,args)."}},
        "additionalProperties": false
      }
    }
  },
  "browser_share": {
    "start": {
      "name": "start",
      "description": "Share an already open browser tab in this Room or corner while you keep using that same browser session. Squire requires an existing operate session id. Chromium attaches to an already running debug port and selects an open tab; it does not launch a browser. The tool returns as soon as the live card is ready. The live browser card is posted in this place. Ask the person to open the card. The result contains no URL. Human browser activity arrives as Room events. End the share explicitly with app_tool(app:beeline:browser_share, tool:end, args:...).",
      "inputSchema": {
        "type": "object",
        "required": ["source"],
        "properties": {
          "source": {"type": "string", "enum": ["squire", "chromium"]},
          "sessionId": {"type": "string", "description": "Existing Trusty Squire operate session id."},
          "target": {
            "type": "string",
            "description": "Chromium tab id, URL fragment, or title fragment; omit for the first open tab."
          },
          "debugUrl": {
            "type": "string",
            "description": "Chromium remote debugging origin; defaults to the local port 9222."
          },
          "title": {"type": "string", "maxLength": 120}
        },
        "additionalProperties": false
      }
    },
    "end": {
      "name": "end",
      "description": "Explicitly end one of your live browser shares in this Room. Use the source sessionId returned by app_tool(app:beeline:browser_share, tool:start, args:...). Closing a viewer or handing control back leaves the share live.",
      "inputSchema": {
        "type": "object",
        "required": ["sessionId"],
        "properties": {"sessionId": {"type": "string"}},
        "additionalProperties": false
      }
    }
  },
  "avatar": {
    "read": {
      "name": "read",
      "description": "Read your current generated avatar drawing and saved soul for /draw-avatar. The daemon token selects you; no other agent can be targeted.",
      "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
    },
    "set": {
      "name": "set",
      "description": "Render and persist your /draw-avatar drawing directly as your current avatar. Follow the draw-avatar skill and its shipped Speakeasy references. Requires an active authorized turn; failure preserves the current face.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "drawing": {
            "type": "array",
            "minItems": 1,
            "maxItems": 128,
            "items": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "type": {"type": "string", "enum": ["path"]},
                    "fill": {"type": "string", "enum": ["bone", "ink", "brass", "none"]},
                    "stroke": {"type": "string", "enum": ["bone", "ink", "brass", "none"]},
                    "strokeWidth": {"type": "number"},
                    "d": {"type": "string"}
                  },
                  "required": ["type"],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {"type": "string", "enum": ["polygon"]},
                    "fill": {"type": "string", "enum": ["bone", "ink", "brass", "none"]},
                    "stroke": {"type": "string", "enum": ["bone", "ink", "brass", "none"]},
                    "strokeWidth": {"type": "number"},
                    "points": {"type": "string"}
                  },
                  "required": ["type"],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {"type": "string", "enum": ["circle"]},
                    "fill": {"type": "string", "enum": ["bone", "ink", "brass", "none"]},
                    "stroke": {"type": "string", "enum": ["bone", "ink", "brass", "none"]},
                    "strokeWidth": {"type": "number"},
                    "cx": {"type": "number"},
                    "cy": {"type": "number"},
                    "r": {"type": "number"}
                  },
                  "required": ["type"],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {"type": "string", "enum": ["ellipse"]},
                    "fill": {"type": "string", "enum": ["bone", "ink", "brass", "none"]},
                    "stroke": {"type": "string", "enum": ["bone", "ink", "brass", "none"]},
                    "strokeWidth": {"type": "number"},
                    "cx": {"type": "number"},
                    "cy": {"type": "number"},
                    "rx": {"type": "number"},
                    "ry": {"type": "number"}
                  },
                  "required": ["type"],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {"type": "string", "enum": ["rect"]},
                    "fill": {"type": "string", "enum": ["bone", "ink", "brass", "none"]},
                    "stroke": {"type": "string", "enum": ["bone", "ink", "brass", "none"]},
                    "strokeWidth": {"type": "number"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "width": {"type": "number"},
                    "height": {"type": "number"},
                    "rx": {"type": "number"}
                  },
                  "required": ["type"],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {"type": "string", "enum": ["line"]},
                    "fill": {"type": "string", "enum": ["bone", "ink", "brass", "none"]},
                    "stroke": {"type": "string", "enum": ["bone", "ink", "brass", "none"]},
                    "strokeWidth": {"type": "number"},
                    "x1": {"type": "number"},
                    "y1": {"type": "number"},
                    "x2": {"type": "number"},
                    "y2": {"type": "number"}
                  },
                  "required": ["type"],
                  "additionalProperties": false
                }
              ]
            }
          }
        },
        "required": ["drawing"],
        "additionalProperties": false
      }
    }
  }
};


/**
 * Claude Code skips root combinators on deployments without its optional
 * rewrite. All harnesses receive the same object schema; branch constraints
 * remain visible in the description and mandatory in server-side validation.
 * Nested schemas are left intact. Never depend on a harness feature flag.
 */
export function invocationTool(tool: ToolDefinition): ToolDefinition {
  return {...tool,inputSchema:{...tool.inputSchema,properties:{
    ...(tool.inputSchema.properties as Record<string,unknown>),
    requestId:{type:'string',minLength:1,description:'The claimed request this tool serves.'},
  }}};
}
export { RUNNER_TOOL } from './minimal-tool-surface-repository-tools.js';
export { SILENT_TOOL } from './minimal-tool-surface-repository-tools.js';
export { placeBeelineApps } from './minimal-tool-surface-repository-tools.js';
export { minimalTools } from './minimal-tool-surface-repository-tools.js';
export { repositoryTools } from './minimal-tool-surface-repository-tools.js';
export { scratchTools } from './minimal-tool-surface-repository-tools.js';
export { toolValidationSchema } from './minimal-tool-surface-repository-tools.js';
export { agentToolsFor } from './minimal-tool-surface-repository-tools.js';
