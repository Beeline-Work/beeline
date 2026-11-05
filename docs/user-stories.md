# Beeline user stories

Each criterion names one visible result for the action in its story. Its ID and platform applicability are the contract for the web, phone and desktop sweeps. Each sweep must cover its applicable criteria exactly once.

## U001 — Visitor signs in with GitHub on Sign in

Route: `/beeline/onboarding`
Platforms: web, android, ios, desktop

- C1: visitor sees the Room deck

## U002 — Visitor signs in with Google on Sign in

Route: `/beeline/onboarding`
Platforms: web, android, ios, desktop

- C2: visitor sees the Room deck

## U003 — Signed-in person claims a handle on onboarding

Route: `/beeline/onboarding`
Platforms: web, android, ios, desktop

- C3: signed-in person sees their chosen identity

## U004 — Returning person resumes a pending device bind on onboarding

Route: `/beeline/onboarding`
Platforms: web, android, ios, desktop

- C4: returning person sees sign-in finish

## U005 — Person selects a Workspace on Workspace chooser

Route: `/beeline/community`
Platforms: web, android, ios, desktop

- C5: person sees its Rooms

## U006 — Person creates a Workspace on Create Workspace

Route: `/beeline/create-workspace`
Platforms: web, android, ios, desktop

- C6: person sees the new Workspace

## U007 — Visitor previews an invite on Workspace chooser

Route: `/beeline/community`
Platforms: web, android, ios, desktop

- C7: visitor sees the invite page

## U008 — Invitee accepts an invite on Join

Route: `/join/[token]`
Platforms: web, android, ios, desktop

- C8: invitee sees the joined Workspace

## U009 — Invitee opens an invalid invite on Join

Route: `/join/[token]`
Platforms: web, android, ios, desktop

- C9: invitee sees an expired-invite explanation

## U010 — Member opens Beeline on the Room deck

Route: `/beeline/channels`
Platforms: web, android, ios, desktop

- C10: member sees their authorized Rooms and unread state

## U011 — Member switches Workspace on the Room deck

Route: `/beeline/channels`
Platforms: web, android, ios, desktop

- C11: member sees that Workspace's Rooms

## U012 — Member starts a Room on the Room deck

Route: `/beeline/channels`
Platforms: web, android, ios, desktop

- C12: member sees the new conversation

## U013 — Member opens a Room on the Room deck

Route: `/beeline/channels`
Platforms: web, android, ios, desktop

- C13: member sees its transcript and composer

## U014 — Member leaves a Room on the Room deck

Route: `/beeline/channels`
Platforms: web, android, ios, desktop

- C14: member sees it removed from the deck

## U015 — Member closes a DM on the Room deck

Route: `/beeline/channels`
Platforms: web, android, ios, desktop

- C15: member sees it removed from the deck

## U016 — Member searches messages on the Room deck

Route: `/beeline/channels`
Platforms: web, android, ios, desktop

- C16: member sees matching authorized messages

## U017 — Member opens a message search hit on the Room deck

Route: `/beeline/channels`
Platforms: web, android, ios, desktop

- C17: member sees that message in its Room

## U018 — Member sends a message in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C18: member sees the committed message in the timeline

## U019 — Member replies to a message in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C19: member sees the linked reply

## U020 — Member tags an agent in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C20: member sees its answer in the timeline

## U021 — Member attaches a file in the composer

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C21: member sees the sent attachment

## U022 — Member reacts to a Room message

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C22: member sees the reaction toggle

## U023 — Author deletes a Room message

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C23: author sees it removed from the timeline

## U024 — Member saves a Room message

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C24: member sees its Saved marker and Tray entry

## U025 — Member reports a Room message

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C25: member sees the feedback acknowledgement

## U026 — Member scrolls older Room messages

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C26: member sees the preceding history

## U027 — Member jumps to a quoted Room message

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C27: member sees the target highlighted

## U028 — Member opens a notification

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C28: member sees the addressed message in its Room

## U029 — Member reads or marks unread in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C29: member sees the read marker and deck badge update

## U030 — Member opens a message attachment in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C30: member sees its image, file, or runnable preview

## U031 — Member copies message text in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C31: member sees selectable text or copied acknowledgement

## U032 — Member opens a Room member from the header

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C32: member sees their profile

## U033 — Member creates a corner in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C33: member sees the new corner conversation

## U034 — Member closes a corner in its conversation

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C34: member sees the corner closed

## U035 — Member locks a corner in its action sheet

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C35: member sees its locked state

## U036 — Member answers an approval card in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C36: member sees the decision reflected

## U037 — Member grants or refuses a requested permission in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C37: member sees the settled card

## U038 — Member answers or skips a question in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C38: member sees the answer or skip

## U039 — Member votes in a Room poll

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C39: member sees the recorded choice

## U040 — Requester stops an agent turn in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C40: requester sees work stop

## U041 — Member joins voice from a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C41: member sees the active call controls

## U042 — Member leaves voice in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C42: member sees the call end for them

## U043 — Member resumes an idle voice call

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C43: member sees active voice controls

## U044 — Member links a repository in a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C44: member sees the linked repository

## U045 — Member selects a Room target branch

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C45: member sees that branch on the repository control

## U046 — Member changes Room name or visibility in its sheet

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C46: member sees the saved Room details

## U047 — Manager changes Room membership in its sheet

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C47: manager sees the updated roster

## U048 — Member changes Room notifications in its sheet

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C48: member sees the selected notification setting

## U049 — Manager deletes a Room in its sheet

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C49: manager returns to the Room deck

## U050 — Member opens schedules from a Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C50: member sees the Room's scheduled work

## U051 — Member opens Corners for a Room

Route: `/beeline/corners/[roomId]`
Platforms: web, android, ios, desktop

- C51: member sees open and archived work

## U052 — Member opens a listed corner

Route: `/beeline/corners/[roomId]`
Platforms: web, android, ios, desktop

- C52: member sees that corner conversation

## U053 — Member creates a corner from Corners

Route: `/beeline/corners/[roomId]`
Platforms: web, android, ios, desktop

- C53: member sees the new corner

## U054 — Member opens Tray

Route: `/beeline/tray`
Platforms: web, android, ios, desktop

- C54: member sees asks and saved messages for their Workspaces

## U055 — Member opens a Tray ask or saved message

Route: `/beeline/tray`
Platforms: web, android, ios, desktop

- C55: member sees the originating message

## U056 — Member answers or skips a Tray question

Route: `/beeline/tray`
Platforms: web, android, ios, desktop

- C56: member sees the item settled

## U057 — Member decides a Tray grant

Route: `/beeline/tray`
Platforms: web, android, ios, desktop

- C57: member sees the item settled

## U058 — Member dismisses an item in Tray

Route: `/beeline/tray`
Platforms: web, android, ios, desktop

- C58: member sees it removed with Undo

## U059 — Member clears a Tray section

Route: `/beeline/tray`
Platforms: web, android, ios, desktop

- C59: member sees that section clear with Undo

## U060 — Member removes a saved message in Tray

Route: `/beeline/tray`
Platforms: web, android, ios, desktop

- C60: member sees it removed with Undo

## U061 — Member loads more saved messages in Tray

Route: `/beeline/tray`
Platforms: web, android, ios, desktop

- C61: member sees the next saved page

## U062 — Member opens Members

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C62: member sees people and agents in the Workspace

## U063 — Member searches or pages Members

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C63: member sees matching people or agents

## U064 — Manager invites a person from Members

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C64: manager sees a shareable invite link

## U065 — Manager connects an agent from Members

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C65: manager sees a pairing code

## U066 — Agent owner edits its name and instructions in profile

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C66: agent owner sees the saved identity

## U067 — Agent owner changes model or thinking in profile

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C67: agent owner sees the selected model configuration

## U068 — Agent owner enables Fast mode in profile

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C68: agent owner sees Fast mode selected

## U069 — Agent owner changes access policy in profile

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C69: agent owner sees who may address the agent

## U070 — Agent owner changes Yolo in profile

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C70: agent owner sees the selected permission mode

## U071 — Agent owner changes wake settings in profile

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C71: agent owner sees the saved wake setting

## U072 — Agent owner refreshes provider usage in profile

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C72: agent owner sees current plan usage

## U073 — Agent owner refreshes available models in profile

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C73: agent owner sees the refreshed model choices

## U074 — Manager removes an agent from Members

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C74: manager sees it disappear from the Workspace

## U075 — Member opens a person's profile

Route: `/beeline/human-profile`
Platforms: web, android, ios, desktop

- C75: member sees their identity, agents and grants

## U076 — Member messages a person from profile

Route: `/beeline/human-profile`
Platforms: web, android, ios, desktop

- C76: member sees their DM

## U077 — Manager changes a person's Workspace role

Route: `/beeline/human-profile`
Platforms: web, android, ios, desktop

- C77: manager sees the new access level

## U078 — Manager removes a person from Workspace profile

Route: `/beeline/human-profile`
Platforms: web, android, ios, desktop

- C78: manager sees them removed

## U079 — Owner revokes a grant on profile

Route: `/beeline/human-profile`
Platforms: web, android, ios, desktop

- C79: person sees the grant revoked

## U080 — Person opens Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C80: person sees account, device and Workspace settings

## U081 — Person opens their GitHub handle in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C81: person sees their GitHub profile

## U082 — Person changes their face in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C82: person sees the selected face

## U083 — Person changes notification level in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C83: person sees the selected level

## U084 — Person retries push setup in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C84: person sees notification registration status

## U085 — Person connects GitHub from Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C85: person sees the linked account

## U086 — Person connects Google from Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C86: person sees the linked account

## U087 — Person checks for an update in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C87: person sees update availability or completion

## U088 — Person signs out in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C88: person sees Sign in

## U089 — Person deletes their account in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C89: person sees the signed-out state

## U090 — Workspace manager edits Workspace details in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C90: workspace manager sees saved name and visibility

## U091 — Workspace owner deletes Workspace in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C91: workspace owner sees it removed

## U092 — Person opens privacy, terms or feedback from Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C92: person sees the external destination

## U093 — Person opens Connectors

Route: `/beeline/settings/workbench`
Platforms: web, android, ios, desktop

- C93: person sees their companies, connections and suggestions

## U094 — Person searches Connectors

Route: `/beeline/settings/workbench/connect-app`
Platforms: web, android, ios, desktop

- C94: person sees matching apps and sign-in routes

## U095 — Person pairs a connector with a helper

Route: `/beeline/settings/workbench/connect`
Platforms: web, android, ios, desktop

- C95: person sees its connection state

## U096 — Person completes connector sign-in

Route: `/beeline/settings/workbench/connect-signin`
Platforms: web, android, ios, desktop

- C96: person sees the connected app

## U097 — Person accepts an agent connector offer

Route: `/beeline/settings/workbench/connect-signin`
Platforms: web, android, ios, desktop

- C97: person sees the app connected

## U098 — Person opens an app in Connectors

Route: `/beeline/settings/workbench/app`
Platforms: web, android, ios, desktop

- C98: person sees its status and available capabilities

## U099 — Person reconnects an app from its detail

Route: `/beeline/settings/workbench/app`
Platforms: web, android, ios, desktop

- C99: person sees reconnection progress or ready status

## U100 — Person disconnects an app from its detail

Route: `/beeline/settings/workbench/app`
Platforms: web, android, ios, desktop

- C100: person sees it disconnected

## U101 — Person opens a company in Connectors

Route: `/beeline/settings/workbench/service`
Platforms: web, android, ios, desktop

- C101: person sees its logins, keys and apps

## U102 — Person connects or disconnects a Squire machine

Route: `/beeline/settings/workbench/service`
Platforms: web, android, ios, desktop

- C102: person sees that machine's connection state

## U103 — Person opens the vault from company detail

Route: `/beeline/settings/workbench/service`
Platforms: web, android, ios, desktop

- C103: person sees Trusty Squire's vault

## U104 — Person opens a saved connection

Route: `/beeline/settings/workbench/connection`
Platforms: web, android, ios, desktop

- C104: person sees its grants and activity

## U105 — Person revokes connection grants

Route: `/beeline/settings/workbench/connection`
Platforms: web, android, ios, desktop

- C105: person sees the updated grants and pending state

## U106 — Person opens Wallet

Route: `/beeline/settings/workbench/wallet`
Platforms: web, android, ios, desktop

- C106: person sees address, balances and transaction history

## U107 — Person enables agent signing in Wallet

Route: `/beeline/settings/workbench/wallet`
Platforms: web, android, ios, desktop

- C107: person sees signing permission active

## U108 — Person revokes agent signing in Wallet

Route: `/beeline/settings/workbench/wallet`
Platforms: web, android, ios, desktop

- C108: person sees signing permission removed

## U109 — Person copies or displays their Wallet address

Route: `/beeline/settings/workbench/wallet`
Platforms: web, android, ios, desktop

- C109: person sees Copied or its QR

## U110 — Person sends funds from Wallet

Route: `/beeline/settings/workbench/wallet-send`
Platforms: web, android, ios, desktop

- C110: person sees the recorded transfer outcome

## U111 — Person opens Receive in Wallet

Route: `/beeline/settings/workbench/wallet-receive`
Platforms: web, android, ios, desktop

- C111: person sees the receiving address and QR

## U112 — Member opens Scheduled Work

Route: `/beeline/settings/schedules`
Platforms: web, android, ios, desktop

- C112: member sees schedules and subscriptions

## U113 — Member opens a schedule

Route: `/beeline/settings/schedule`
Platforms: web, android, ios, desktop

- C113: member sees its cadence, actor and instructions

## U114 — Manager stops a schedule

Route: `/beeline/settings/schedule`
Platforms: web, android, ios, desktop

- C114: manager sees the stopped result

## U115 — Member opens a subscription

Route: `/beeline/settings/subscription`
Platforms: web, android, ios, desktop

- C115: member sees its trigger, source and recent calls

## U116 — Manager reveals or copies a webhook token

Route: `/beeline/settings/subscription`
Platforms: web, android, ios, desktop

- C116: manager sees the token or copied acknowledgement

## U117 — Manager rotates a webhook token

Route: `/beeline/settings/subscription`
Platforms: web, android, ios, desktop

- C117: manager sees the new token

## U118 — Manager stops a subscription

Route: `/beeline/settings/subscription`
Platforms: web, android, ios, desktop

- C118: manager sees the stopped result

## U119 — Room manager opens repository Workflows

Route: `/beeline/settings/workflows`
Platforms: web, android, ios, desktop

- C119: room manager sees available GitHub workflow runs

## U120 — Member opens a workflow

Route: `/beeline/workflow`
Platforms: web, android, ios, desktop

- C120: member sees its steps and run history

## U121 — Member opens a workflow run

Route: `/beeline/workflow-run`
Platforms: web, android, ios, desktop

- C121: member sees reached steps, results and live output

## U122 — Member opens a workflow gate or corner link

Route: `/beeline/workflow-run`
Platforms: web, android, ios, desktop

- C122: member sees its source conversation

## U123 — Member switches to another live workflow run

Route: `/beeline/workflow-run`
Platforms: web, android, ios, desktop

- C123: member sees the selected run

## U124 — Authorized person opens a browser share

Route: `/beeline/browser-share`
Platforms: web, android, ios, desktop

- C124: authorized person sees the remote browser

## U125 — Authorized person closes the browser viewer

Route: `/beeline/browser-share`
Platforms: web, android, ios, desktop

- C125: authorized person sees the previous Beeline screen

## U126 — Member opens a message document

Route: `/artifact-viewer`
Platforms: web, android, ios, desktop

- C126: member sees its full text and can return

## U127 — Member opens Select Text and copies it

Route: `/text-selection`
Platforms: web, android, ios, desktop

- C127: member sees selectable content and copy acknowledgement

## U128 — Person opens What's New

Route: `/changelog`
Platforms: web, android, ios, desktop

- C128: person sees release notes

## U129 — Reviewer opens a review sign-in link

Route: `/review/[secret]`
Platforms: web, android, ios, desktop

- C129: reviewer sees the authorized Room deck

## U130 — Person installs the GitHub App from repository setup

Route: `/beeline/github-installation`
Platforms: web, android, ios, desktop

- C130: person sees available repositories

## U131 — Member creates or chooses a repository from the Room card

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C131: member sees the linked repository

## U132 — Person changes appearance in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C132: person sees the chosen light or dark theme

## U133 — Person changes display size in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C133: person sees resized controls and text

## U134 — Person changes speaking speed in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C134: person sees the saved speed

## U135 — Manager changes the Workspace picture in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C135: manager sees the uploaded or generated mark

## U136 — Member copies the public Workspace join link in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C136: member sees Copied

## U137 — Manager toggles Allow fix sweep in Settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C137: manager sees the selected setting

## U138 — Member joins a discoverable Room from Workspace settings

Route: `/beeline/settings/identity`
Platforms: web, android, ios, desktop

- C138: member sees that Room

## U139 — Agent owner previews a voice in profile

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C139: agent owner hears the sample and sees playback state

## U140 — Agent owner chooses a voice in profile

Route: `/beeline/members`
Platforms: web, android, ios, desktop

- C140: agent owner sees the saved voice

## U141 — Member mutes or unmutes their Room microphone

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C141: member sees the mute indicator

## U142 — Member pins an agent in the voice bar

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C142: member sees the chosen agent targeted

## U143 — Member dictates a message in the Room composer

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C143: member sees the dictated text ready to send

## U144 — Member pastes or drops a file into the desktop composer

Route: `/beeline/chat/[channelId]`
Platforms: web, desktop

- C144: member sees the staged attachment

## U145 — Member retries a failed composer attachment

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C145: member sees its upload state recover

## U146 — Member forwards a message to a person or Room

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C146: member sees the forwarded content at the destination

## U147 — Desktop member opens work in the side inspector

Route: `/beeline/chat/[channelId]`
Platforms: web, desktop

- C147: desktop member sees that conversation alongside the Room

## U148 — Desktop member resizes the sidebar or inspector

Route: `/beeline/chat/[channelId]`
Platforms: web, desktop

- C148: desktop member sees the panes follow the divider

## U149 — Member returns after a connection loss

Route: `/beeline/chat/[channelId]`
Platforms: web, android, ios, desktop

- C149: member sees committed messages after reconnection

## U150 — Room manager runs a repository workflow on Workflows

Route: `/beeline/settings/workflows`
Platforms: web, android, ios, desktop

- C150: room manager sees the dispatch result

## U151 — Person allows a connected AI app on MCP consent

Route: `/mcp/oauth/consent`
Platforms: web, android, ios, desktop

- C151: person sees the approved member connection

## U152 — Person cancels a connected AI app on MCP consent

Route: `/mcp/oauth/consent`
Platforms: web, android, ios, desktop

- C152: person sees the denied authorization result

## U153 — Visitor opens Sign in

Route: `/beeline/onboarding`
Platforms: web, android, ios, desktop

- C153: visitor sees GitHub and Google sign-in choices
