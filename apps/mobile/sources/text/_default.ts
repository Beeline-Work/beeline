/**
 * English translations for the Happy app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

/**
 * English plural helper function
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on count
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

export const en = {
    tabs: {
        // Tab navigation labels
        sessions: 'Terminals',
        settings: 'Settings',
    },


    common: {
        // Simple string constants
        cancel: 'Cancel',
        authenticate: 'Authenticate',
        save: 'Save',
        saveAs: 'Save As',
        error: 'Error',
        success: 'Success',
        ok: 'OK',
        continue: 'Continue',
        back: 'Back',
        create: 'Create',
        rename: 'Rename',
        reset: 'Reset',
        logout: 'Logout',
        yes: 'Yes',
        no: 'No',
        discard: 'Discard',
        version: 'Version',
        copied: 'Copied',
        copy: 'Copy',
        scanning: 'Scanning...',
        urlPlaceholder: 'https://example.com',
        home: 'Home',
        message: 'Message',
        files: 'Files',
        fileViewer: 'File Viewer',
        loading: 'Loading...',
        retry: 'Retry',
        delete: 'Delete',
        optional: 'optional',
    },

    profile: {
        userProfile: 'User Profile',
        details: 'Details',
        firstName: 'First Name',
        lastName: 'Last Name',
        username: 'Username',
        status: 'Status',
    },

    status: {
        connected: 'connected',
        connecting: 'connecting',
        disconnected: 'disconnected',
        error: 'error',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `last seen ${time}`,
        permissionRequired: 'permission required',
        activeNow: 'Active now',
        unknown: 'unknown',
        unread: 'new results',
    },

    time: {
        justNow: 'just now',
        minutesAgo: ({ count }: { count: number }) => `${count} minute${count !== 1 ? 's' : ''} ago`,
        hoursAgo: ({ count }: { count: number }) => `${count} hour${count !== 1 ? 's' : ''} ago`,
        daysAgo: ({ count }: { count: number }) => `${count} day${count !== 1 ? 's' : ''} ago`,
    },

    connect: {
        enterUrlManually: 'Enter URL manually',
    },

    settings: {
        title: 'Settings',
        github: 'GitHub',
        features: 'Features',
        appearance: 'Appearance',
        appearanceSubtitle: 'Customize how the app looks',
        featuresTitle: 'Features',
        featuresSubtitle: 'Enable or disable app features',
        about: 'About',
        aboutFooter: 'Happy Coder is a Codex and Claude Code mobile client. It\'s fully end-to-end encrypted and your account is stored only on your device. Not affiliated with Anthropic.',
        whatsNew: 'What\'s New',
        whatsNewSubtitle: 'See the latest updates and improvements',
        reportIssue: 'Report an Issue',
        privacyPolicy: 'Privacy Policy',
        termsOfService: 'Terms of Service',
        eula: 'EULA',
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'enabled' : 'disabled'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Theme',
        themeDescription: 'Choose your preferred color scheme',
        themeOptions: {
            adaptive: 'Adaptive',
            light: 'Light', 
            dark: 'Dark',
        },
        themeDescriptions: {
            adaptive: 'Match system settings',
            light: 'Always use light theme',
            dark: 'Always use dark theme',
        },
        chat: 'Chat',
        chatDescription: 'Customize chat message appearance',
        sessionStatusBar: 'Session Status Info',
        sessionStatusBarDescription: 'Choose where branch, model, effort, and context appear',
        sessionStatusDisplayOptions: {
            hidden: 'Hidden',
            above: 'Above composer',
            below: 'Below composer',
        },
        usageLimitShowRemaining: 'Show Quota Remaining',
        usageLimitShowRemainingDescription: 'Count plan limits down from full instead of up from empty',
        userMessageBubbleColor: 'User Bubble Color',
        userMessageBubbleColorDescription: 'Make your messages easier to spot in long chats',
        userMessageBubbleColorOptions: {
            blue: 'Blue',
            green: 'Green',
            purple: 'Purple',
            rose: 'Rose',
            sand: 'Sand',
            gray: 'Gray',
        },
        display: 'Display',
        displayDescription: 'Control layout and spacing',
        compactToolCalls: 'Compact Tool Calls',
        compactToolCallsDescription: 'Show non-interactive tool calls as one-line rows; open a row for details',
        inlineToolCalls: 'Inline Tool Calls',
        inlineToolCallsDescription: 'Display tool calls directly in chat messages',
        expandTodoLists: 'Expand Todo Lists',
        expandTodoListsDescription: 'Show all todos instead of just changes',
        showLineNumbersInDiffs: 'Show Line Numbers in Diffs',
        showLineNumbersInDiffsDescription: 'Display line numbers in code diffs',
        showLineNumbersInToolViews: 'Show Line Numbers in Tool Views',
        showLineNumbersInToolViewsDescription: 'Display line numbers in tool view diffs',
        wrapLinesInDiffs: 'Wrap Lines in Diffs',
        wrapLinesInDiffsDescription: 'Wrap long lines instead of horizontal scrolling in diff views',
        diffStyle: 'Diff View',
        diffStyleDescription: 'Show diffs as a single column (unified) or side-by-side (split). Split view is web-only.',
        diffStyleOptions: {
            unified: 'Unified',
            split: 'Split',
        },
        alwaysShowContextSize: 'Always Show Context Size',
        alwaysShowContextSizeDescription: 'Display context usage even when not near limit',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Experiments',
        experimentsDescription: 'Enable experimental features that are still in development. These features may be unstable or change without notice.',
        experimentalFeatures: 'Experimental Features',
        experimentalFeaturesEnabled: 'Experimental features enabled',
        experimentalFeaturesDisabled: 'Using stable features only',
        webFeatures: 'Web Features',
        webFeaturesDescription: 'Features available only in the web version of the app.',
        enterToSend: 'Enter to Send',
        enterToSendEnabled: 'Press Enter to send (Shift+Enter for a new line)',
        enterToSendDisabled: 'Enter inserts a new line',
        commandPalette: 'Command Palette',
        commandPaletteEnabled: 'Press ⌘K to open',
        commandPaletteDisabled: 'Quick command access disabled',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Long press opens copy modal',
        hideInactiveSessions: 'Hide inactive sessions',
        hideInactiveSessionsSubtitle: 'Show only active chats in your list',
        groupToolCalls: 'Group Tool Calls',
        groupToolCallsSubtitle: 'Collapse consecutive tool calls into one container',
        privacy: 'Privacy',
        privacyDescription: 'Completely disables all analytics and telemetry. No data will be sent to PostHog or any other tracking service.',
        disableAnalytics: 'Disable Analytics',
        analyticsDisabled: 'All tracking and telemetry disabled',
        analyticsEnabled: 'Anonymous usage analytics active',
        imageUpload: 'Image Upload',
        imageUploadSubtitle: 'Attach images to messages for supported agents to analyze',
    },

    beelineIdentity: {
        handleCeremonyLabel: 'IDENTITY · HANDLE CEREMONY',
        handleInvalidTitle: 'HANDLE NOT AVAILABLE',
        handleInvalidMessage: 'Use 3–30 lowercase letters, numbers, or dashes.',
        handleTakenTitle: 'HANDLE ALREADY CLAIMED',
        handleClaimFailedTitle: 'HANDLE NOT CLAIMED',
        handleTakenMessage: ({ handle }: { handle: string }) => `@${handle} belongs to someone else. Choose another handle.`,
        handleCeremonyTitle: 'Choose your handle',
        handleCeremonyBody: 'This name is bound to your key. It becomes your verified Beeline identity everywhere.',
        handleAccessibility: 'Choose your Beeline handle',
        handlePlaceholder: 'ada-labs',
        handleRules: '3–30 · a–z · 0–9 · dash',
        claimHandle: 'Claim handle',
        githubLinkedNotice: 'GitHub linked to this key. Your identity and history stayed in place.',
        githubRenameNotice: ({ handle }: { handle: string }) => `Your verified handle is now @${handle}.`,
        claimStatusInvalid: 'USE 3-30 LOWERCASE LETTERS, NUMBERS, OR DASHES',
        hostedHandleClaimBody: 'Claim your verified handle at usebeeline.app, first come first served.',
        linkGithub: 'Link GitHub to this key',
        renameOffer: ({ current, github }: { current: string; github: string }) => `Keep @${current}, or use your GitHub handle once: @${github}.`,
        useGithubHandle: ({ handle }: { handle: string }) => `Use @${handle}`,
    },

    imageUpload: {
        permissionTitle: 'Photo Library Access',
        permissionMessage: 'Allow access to your photo library to attach images to messages.',
        limitTitle: 'Image Limit Reached',
        limitMessage: ({ max }: { max: number }) => `You can attach up to ${max} images per message.`,
        fileTooLargeTitle: 'File Too Large',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" exceeds the ${maxMb}MB limit and was not added.`,
        uploadFailedTitle: 'Upload Failed',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'One image could not be uploaded and was not sent.'
            : `${count} images could not be uploaded and were not sent.`,
        notSupportedTitle: 'Images Not Supported',
        notSupportedMessage: 'This agent does not support image attachments. Images were not sent.',
    },

    errors: {
        networkError: 'Network error occurred',
        serverError: 'Server error occurred',
        unknownError: 'An unknown error occurred',
        connectionTimeout: 'Connection timed out',
        authenticationFailed: 'Authentication failed',
        permissionDenied: 'Permission denied',
        fileNotFound: 'File not found',
        invalidFormat: 'Invalid format',
        operationFailed: 'Operation failed',
        tryAgain: 'Please try again',
        contactSupport: 'Contact support if the problem persists',
        sessionNotFound: 'Session not found',
        voiceSessionFailed: 'Failed to start voice session',
        voiceServiceUnavailable: 'Voice service is temporarily unavailable',
        voiceLimitReachedTitle: 'Voice Limit Reached',
        voiceHardLimitReached: ({ hours }: { hours: number }) => `You've used ${hours}+ hours of voice this month. This is the maximum allowed. You can configure your own ElevenLabs agent in Voice settings to use your own quota.`,
        voiceConversationLimitReached: 'You\'ve reached the maximum number of voice conversations this month. We may add on-demand voice usage in the future — please file an issue at github.com/nicepkg/happy/issues if you hit this limit.',
        oauthInitializationFailed: 'Failed to initialize OAuth flow',
        tokenStorageFailed: 'Failed to store authentication tokens',
        oauthStateMismatch: 'Security validation failed. Please try again',
        tokenExchangeFailed: 'Failed to exchange authorization code',
        oauthAuthorizationDenied: 'Authorization was denied',
        webViewLoadFailed: 'Failed to load authentication page',
        failedToLoadProfile: 'Failed to load user profile',
        userNotFound: 'User not found',
        sessionDeleted: 'Session has been deleted',
        sessionDeletedDescription: 'This session has been permanently removed',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} must be between ${min} and ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Retry in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Error ${code})`,
    },

    newSession: {
        title: 'Start New Session',
        machineOffline: 'Machine is offline',
        switchMachinesHint: '• Switch machines by clicking on the machine above',
    },

    sessionHistory: {
        // Used by session history screen
        empty: 'No sessions found',
        daysAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'day' : 'days'} ago`,
    },

    session: {
        inputPlaceholder: 'Type a message ...',
        inactiveArchived: 'This session is inactive.',
        resumeFromTerminal: 'To resume it from the terminal:',
        newChat: 'New chat',
        statusBarContext: 'Context',
        statusBarPathTitle: 'Working directory',
        // Fork / duplicate / rewind flow (Claude only)
        forkAction: 'Fork session',
        forkSubtitle: 'Continue in a new session with the same context',
        duplicateAction: 'Duplicate from message…',
        duplicateSubtitle: 'Rewind to a chosen point and try again',
        forkFromHere: 'Fork from here',
        duplicateSheetTitle: 'Choose a rewind point',
        duplicateSheetSubtitle: 'The new session keeps the chosen turn complete (your message and the agent’s response) and drops every prompt after it.',
        duplicateSheetConfirm: 'Duplicate',
        duplicateSheetEmpty: 'No messages eligible for rewind in this session yet.',
        duplicateRowDisabled: "This message can't be used as a rewind point.",
        forkedFromLabel: 'Forked from',
        forkedFromSubtitle: 'Open the session this fork was branched from',
        forkErrorOffline: 'This machine is offline. Fork is only available while the machine that owns the session is online.',
        forkErrorMissingUuid: 'The chosen rewind point is no longer present in the source session — try forking without truncation.',
        forkErrorMissingMetadata: 'Missing session metadata required to fork.',
        forkErrorGeneric: 'Failed to fork the session.',
        forkClaudeOnly: 'Fork is currently only supported for Claude sessions.',
    },

    commandPalette: {
        placeholder: 'Type a command or search...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Kill Session',
        killSessionConfirm: 'Are you sure you want to terminate this session?',
        archiveSession: 'Archive Session',
        archiveSessionConfirm: 'Are you sure you want to archive this session?',
        happySessionIdCopied: 'Happy Session ID copied to clipboard',
        failedToCopySessionId: 'Failed to copy Happy Session ID',
        happySessionId: 'Happy Session ID',
        claudeCodeSessionId: 'Claude Code Session ID',
        claudeCodeSessionIdCopied: 'Claude Code Session ID copied to clipboard',
        codexThreadId: 'Codex Thread ID',
        codexThreadIdCopied: 'Codex Thread ID copied to clipboard',
        aiProvider: 'AI Provider',
        failedToCopyClaudeCodeSessionId: 'Failed to copy Claude Code Session ID',
        failedToCopyCodexThreadId: 'Failed to copy Codex Thread ID',
        metadataCopied: 'Session metadata copied to clipboard',
        failedToCopyMetadata: 'Failed to copy session metadata',
        failedToKillSession: 'Failed to kill session',
        failedToArchiveSession: 'Failed to archive session',
        connectionStatus: 'Connection Status',
        created: 'Created',
        lastUpdated: 'Last Updated',
        sequence: 'Sequence',
        quickActions: 'Quick Actions',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionNeedsHappyAgent: 'Resume is unavailable on this machine. Run `happy-agent auth login` to enable it.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Claude or Codex identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        killSessionSubtitle: 'Immediately terminate the session',
        archiveSessionSubtitle: 'Archive this session and stop it',
        metadata: 'Metadata',
        host: 'Host',
        path: 'Path',
        operatingSystem: 'Operating System',
        processId: 'Process ID',
        happyHome: 'Happy Home',
        copyMetadata: 'Copy session metadata',
        agentState: 'Agent State',
        controlledByUser: 'Controlled by User',
        pendingRequests: 'Pending Requests',
        activity: 'Activity',
        thinking: 'Thinking',
        thinkingSince: 'Thinking Since',
        cliVersion: 'CLI Version',
        cliVersionOutdated: 'CLI Update Required',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Version ${currentVersion} installed. Update to ${requiredVersion} or later`,
        updateCliInstructions: 'Please run npm install -g happy@latest',
        deleteSession: 'Delete Session',
        deleteSessionSubtitle: 'Permanently remove this session',
        deleteSessionConfirm: 'Delete Session Permanently?',
        deleteSessionWarning: 'This action cannot be undone. All messages and data associated with this session will be permanently deleted.',
        failedToDeleteSession: 'Failed to delete session',
        sessionDeleted: 'Session deleted successfully',
        worktreeCleanupTitle: 'Delete Worktree?',
        worktreeCleanupMessage: 'The worktree has no uncommitted changes. Would you like to delete the worktree files?',
        worktreeCleanupDelete: 'Delete Worktree',
        worktreeCleanupKeep: 'Keep Files',
        
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Ready to code?',
            installCli: 'Install the Happy CLI',
            runIt: 'Run it',
            scanQrCode: 'Scan the QR code',
            openCamera: 'Open Camera',
        },
        agentGoalBar: {
            currentGoal: 'Current goal',
            accessibilityLabel: ({ goal }: { goal: string }) => `Current goal: ${goal}`,
            clearGoal: 'Clear goal',
            stopGoal: 'Stop goal',
            editGoal: 'Edit goal',
        },
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Context ${used} of ${total} tokens, ${percent}%`,
            limitFiveHour: '5-hour limit',
            limitSevenDay: '7-day limit',
            limitResets: ({ time }: { time: string }) => `resets ${time}`,
            limitAsOf: ({ age }: { age: string }) => `as of ${age} ago`,
            limitRemaining: ({ percent }: { percent: number }) => `${percent}% left`,
        },
    },

    agentInput: {
        permissionMode: {
            title: 'PERMISSION MODE',
            default: 'default permissions',
            acceptEdits: 'accept edits',
            plan: 'plan',
            dontAsk: "don't ask",
            bypassPermissions: 'yolo',
            badgeAcceptAllEdits: 'accept all edits',
            badgeBypassAllPermissions: 'yolo',
            badgePlanMode: 'plan mode',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
            openclaw: 'OpenClaw',
        },
        model: {
            title: 'MODEL',
            configureInCli: 'Configure models in CLI settings',
        },
        effort: {
            title: 'EFFORT',
        },
        codexPermissionMode: {
            title: 'CODEX PERMISSION MODE',
            default: 'default permissions',
            readOnly: 'read-only',
            safeYolo: 'safe yolo',
            yolo: 'yolo',
            defaultDescription: 'ask before untrusted commands',
            readOnlyDescription: 'no writes',
            safeYoloDescription: 'no prompts, workspace sandbox',
            yoloDescription: 'no prompts, full access',
            badgeReadOnly: 'read-only',
            badgeSafeYolo: 'safe yolo',
            badgeYolo: 'yolo',
        },
        codexModel: {
            title: 'CODEX MODEL',
            gpt5CodexLow: 'gpt-5-codex low',
            gpt5CodexMedium: 'gpt-5-codex medium',
            gpt5CodexHigh: 'gpt-5-codex high',
            gpt5Minimal: 'GPT-5 Minimal',
            gpt5Low: 'GPT-5 Low',
            gpt5Medium: 'GPT-5 Medium',
            gpt5High: 'GPT-5 High',
        },
        geminiPermissionMode: {
            title: 'GEMINI PERMISSION MODE',
            default: 'default permissions',
            autoEdit: 'auto edit',
            yolo: 'yolo',
            plan: 'plan',
            badgeAutoEdit: 'auto edit',
            badgeYolo: 'yolo',
            badgePlan: 'plan',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% left`,
        },
        suggestion: {
            fileLabel: 'FILE',
            folderLabel: 'FOLDER',
        },
        noMachinesAvailable: 'No machines',
    },

    machineLauncher: {
        showLess: 'Show less',
        showAll: ({ count }: { count: number }) => `Show all (${count} paths)`,
        enterCustomPath: 'Enter custom path',
        offlineUnableToSpawn: 'Unable to spawn new session, offline',
    },

    agentQuestion: {
        title: 'Question',
        submit: 'Send answer',
        chooseMultiple: 'Choose as many as apply',
        ownAnswer: 'Your own answer',
        ownAnswerPlaceholder: 'Write an answer instead',
        submitFailed: 'Could not send your answer',
        dismiss: 'Dismiss',
        unsupportedTitle: 'Unsupported request',
        unsupportedDescription: ({ kind }: { kind: string }) =>
            `This version of Happy cannot show a "${kind}" request. Update the app to respond.`,
        moreQuestions: ({ count }: { count: number }) =>
            count === 1 ? '1 more question' : `${count} more questions`,
    },

    sidebar: {
        sessionsTitle: 'Happy',
        showArchived: 'Show archived',
        hideArchived: 'Hide archived',
        newSession: 'New session',
        projects: 'Projects',
    },

    zen: {
        toggle: 'Zen mode',
    },

    toolView: {
        input: 'Input',
        output: 'Output',
    },

    toolGroup: {
        editedFile: 'Edited file',
        editedFiles: ({ count }: { count: number }) => count === 1 ? 'Edited 1 file' : `Edited ${count} files`,
        readFiles: ({ count }: { count: number }) => count === 1 ? 'Read 1 file' : `Read ${count} files`,
        ranCommands: ({ count }: { count: number }) => count === 1 ? 'Ran 1 command' : `Ran ${count} commands`,
        searched: ({ count }: { count: number }) => count === 1 ? 'Searched 1 time' : `Searched ${count} times`,
        fetchedUrls: ({ count }: { count: number }) => count === 1 ? 'Fetched 1 URL' : `Fetched ${count} URLs`,
        ranTasks: ({ count }: { count: number }) => count === 1 ? 'Ran 1 task' : `Ran ${count} tasks`,
        usedTools: ({ count }: { count: number }) => count === 1 ? 'Used 1 tool' : `Used ${count} tools`,
        workedFor: ({ duration }: { duration: string }) => `Worked ${duration}`,
    },

    tools: {
        fullView: {
            description: 'Description',
            inputParams: 'Input Parameters',
            output: 'Output',
            error: 'Error',
            completed: 'Tool completed successfully',
            noOutput: 'No output was produced',
            running: 'Tool is running...',
            rawJsonDevMode: 'Raw JSON (Dev Mode)',
        },
        taskView: {
            initializing: 'Initializing agent...',
            moreTools: ({ count }: { count: number }) => `+${count} more ${plural({ count, singular: 'tool', plural: 'tools' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Edit ${index} of ${total}`,
            replaceAll: 'Replace All',
        },
        names: {
            task: 'Task',
            terminal: 'Terminal',
            searchFiles: 'Search Files',
            search: 'Search',
            searchContent: 'Search Content',
            listFiles: 'List Files',
            planProposal: 'Plan proposal',
            readFile: 'Read File',
            editFile: 'Edit File',
            writeFile: 'Write File',
            fetchUrl: 'Fetch URL',
            readNotebook: 'Read Notebook',
            editNotebook: 'Edit Notebook',
            todoList: 'Todo List',
            webSearch: 'Web Search',
            reasoning: 'Reasoning',
            applyChanges: 'Update file',
            viewDiff: 'Current file changes',
            question: 'Question',
        },
        askUserQuestion: {
            submit: 'Submit Answer',
            multipleQuestions: ({ count }: { count: number }) => `${count} questions`,
            other: 'Other',
            otherDescription: 'Type your own answer',
            otherPlaceholder: 'Type your answer...',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Search(pattern: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Search(path: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Fetch URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Edit Notebook(file: ${path}, mode: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Todo List(count: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Web Search(query: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(pattern: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} edits)`,
            readingFile: ({ file }: { file: string }) => `Reading ${file}`,
            writingFile: ({ file }: { file: string }) => `Writing ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Modifying ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Modifying ${count} files`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} and ${count} more`,
            showingDiff: 'Showing changes',
        }
    },

    files: {
        changes: 'Changes',
        searchPlaceholder: 'Search files...',
        detachedHead: 'detached HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} staged • ${unstaged} unstaged`,
        notRepo: 'Not a git repository',
        notUnderGit: 'This directory is not under git version control',
        searching: 'Searching files...',
        noFilesFound: 'No files found',
        noFilesInProject: 'No files in project',
        tryDifferentTerm: 'Try a different search term',
        searchResults: ({ count }: { count: number }) => `Search Results (${count})`,
        projectRoot: 'Project root',
        stagedChanges: ({ count }: { count: number }) => `Staged Changes (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Unstaged Changes (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Loading ${fileName}...`,
        binaryFile: 'Binary File',
        cannotDisplayBinary: 'Cannot display binary file content',
        diff: 'Diff',
        file: 'File',
        fileEmpty: 'File is empty',
        noChanges: 'No changes to display',
        noChangesTitle: 'No changes',
        noChangesSubtitle: 'Working tree is clean',
        deleted: 'Deleted',
        changedFiles: ({ count }: { count: number }) => `${count} changed ${count === 1 ? 'file' : 'files'}`,
        allFiles: 'All Files',
        addPanel: 'Add panel',
        closePanel: 'Close panel',
        editFile: 'Edit',
        saveFile: 'Save',
        failedToRead: 'Failed to read file',
        failedToSave: 'Failed to save file',
        fileConflict: 'File conflict',
        fileConflictDescription: 'This file was modified on the device while you were editing. Reload to see the latest version.',
        reload: 'Reload',
        overwrite: 'Overwrite',
    },
    sideChat: {
        panelTitle: 'Side chat',
        emptyTitle: 'Start a side chat',
        emptySubtitle: 'Ask the agent something on the side. It inherits this chat’s context but stays isolated — nothing here touches the main conversation.',
        startButton: 'Start side chat',
        creating: 'Starting side chat…',
        unavailable: 'This session can’t start a side chat yet — wait for the agent to come online.',
        composerPlaceholder: 'Message side chat…',
        expand: 'Open full screen',
        tabLabel: ({ index }: { index: number }) => `Side chat ${index}`,
        newChat: 'New side chat',
        close: 'Close side chat',
    },



    settingsLanguage: {
        // Language settings screen
        title: 'Language',
        description: 'Choose your preferred language for the app interface. This will sync across all your devices.',
        currentLanguage: 'Current Language',
        automatic: 'Automatic',
        automaticSubtitle: 'Detect from device settings',
        needsRestart: 'Language Changed',
        needsRestartMessage: 'The app needs to restart to apply the new language setting.',
        restartNow: 'Restart Now',
    },


    updateBanner: {
        updateAvailable: 'Update available',
        pressToApply: 'Press to apply the update',
        whatsNew: "What's new",
        seeLatest: 'See the latest updates and improvements',
        nativeUpdateAvailable: 'App Update Available',
        tapToUpdateAppStore: 'Tap to update in App Store',
        tapToUpdatePlayStore: 'Tap to update in Play Store',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Version ${version}`,
        noEntriesAvailable: 'No changelog entries available.',
    },


    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Authenticate Terminal',
        pasteUrlFromTerminal: 'Paste the authentication URL from your terminal',
        deviceLinkedSuccessfully: 'Device linked successfully',
        terminalConnectedSuccessfully: 'Terminal connected successfully',
        invalidAuthUrl: 'Invalid authentication URL',
        failedToConnectTerminal: 'Failed to connect terminal',
        cameraPermissionsRequiredToConnectTerminal: 'Camera permissions are required to connect terminal',
        failedToLinkDevice: 'Failed to link device',
        cameraPermissionsRequiredToScanQr: 'Camera permissions are required to scan QR codes'
    },

    navigation: {
        // Navigation titles and screen headers
        whatsNew: "What's New",
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Codex and Claude Code mobile client',
        subtitle: 'End-to-end encrypted and your account is stored only on your device.',
        createAccount: 'Create account',
        linkOrRestoreAccount: 'Link or restore account',
        loginWithMobileApp: 'Login with mobile app',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Enjoying the app?',
        feedbackPrompt: "We'd love to hear your feedback!",
        yesILoveIt: 'Yes, I love it!',
        notReally: 'Not really'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copied to clipboard`
    },

    machine: {
        launchNewSessionInDirectory: 'Launch New Session in Directory',
        offlineUnableToSpawn: 'Launcher disabled while machine is offline',
        offlineHelp: '• Make sure your computer is online\n• Run `happy daemon status` to diagnose\n• Are you running the latest CLI version? Upgrade with `npm install -g happy@latest`',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Switched to ${mode} mode`,
        unknownEvent: 'Unknown event',
        usageLimitUntil: ({ time }: { time: string }) => `Usage limit reached until ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: 'unknown time',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: "Yes, and don't ask for a session",
            stopAndExplain: 'Stop, and explain what to do',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Yes, allow all edits during this session',
            yesAllowEverything: 'Yes, allow everything during this session',
            yesForTool: "Yes, don't ask again for this tool",
            noTellClaude: 'No, and provide feedback',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: 'Select text range',
        title: 'Select Text',
        noTextProvided: 'No text provided',
        textNotFound: 'Text not found or expired',
        textCopied: 'Text copied to clipboard',
        failedToCopy: 'Failed to copy text to clipboard',
        noTextToCopy: 'No text available to copy',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Code copied',
        copyFailed: 'Copy failed',
        mermaidRenderFailed: 'Failed to render mermaid diagram',
    },





} as const;

export type Translations = typeof en;

/**
 * Generic translation type that matches the structure of Translations
 * but allows different string values (for other languages)
 */
export type TranslationStructure = {
    readonly [K in keyof Translations]: {
        readonly [P in keyof Translations[K]]: Translations[K][P] extends string 
            ? string 
            : Translations[K][P] extends (...args: any[]) => string 
                ? Translations[K][P] 
                : Translations[K][P] extends object
                    ? {
                        readonly [Q in keyof Translations[K][P]]: Translations[K][P][Q] extends string
                            ? string
                            : Translations[K][P][Q]
                      }
                    : Translations[K][P]
    }
};
