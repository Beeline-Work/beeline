/**
 * Chinese (Simplified) translations for the Happy app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

import { TranslationStructure } from "../_default";

/**
 * Chinese plural helper function
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on count
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

export const zhHans: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: '终端',
        settings: '设置',
    },


    common: {
        // Simple string constants
        cancel: '取消',
        authenticate: '认证',
        save: '保存',
        saveAs: '另存为',
        error: '错误',
        success: '成功',
        ok: '确定',
        continue: '继续',
        back: '返回',
        create: '创建',
        rename: '重命名',
        reset: '重置',
        logout: '登出',
        yes: '是',
        no: '否',
        discard: '放弃',
        version: '版本',
        copied: '已复制',
        copy: '复制',
        scanning: '扫描中...',
        urlPlaceholder: 'https://example.com',
        home: '主页',
        message: '消息',
        files: '文件',
        fileViewer: '文件查看器',
        loading: '加载中...',
        retry: '重试',
        delete: '删除',
        optional: '可选的',
    },

    profile: {
        userProfile: '用户资料',
        details: '详情',
        firstName: '名',
        lastName: '姓',
        username: '用户名',
        status: '状态',
    },


    status: {
        connected: '已连接',
        connecting: '连接中',
        disconnected: '已断开',
        error: '错误',
        online: '在线',
        offline: '离线',
        lastSeen: ({ time }: { time: string }) => `最后活跃时间 ${time}`,
        permissionRequired: '需要权限',
        activeNow: '当前活跃',
        unknown: '未知',
        unread: '新结果',
    },

    time: {
        justNow: '刚刚',
        minutesAgo: ({ count }: { count: number }) => `${count} 分钟前`,
        hoursAgo: ({ count }: { count: number }) => `${count} 小时前`,
        daysAgo: ({ count }: { count: number }) => `${count} 天前`,
    },

    connect: {
        enterUrlManually: '手动输入 URL',
    },

    settings: {
        title: '设置',
        github: 'GitHub',
        features: '功能',
        appearance: '外观',
        appearanceSubtitle: '自定义应用外观',
        featuresTitle: '功能',
        featuresSubtitle: '启用或禁用应用功能',
        about: '关于',
        aboutFooter: 'Happy Coder 是一个 Codex 和 Claude Code 移动客户端。它采用端到端加密，您的账户仅存储在本地设备上。与 Anthropic 无关联。',
        whatsNew: '更新日志',
        whatsNewSubtitle: '查看最新更新和改进',
        reportIssue: '报告问题',
        privacyPolicy: '隐私政策',
        termsOfService: '服务条款',
        eula: '最终用户许可协议',
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} 已${enabled ? '启用' : '禁用'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: '主题',
        themeDescription: '选择您喜欢的配色方案',
        themeOptions: {
            adaptive: '自适应',
            light: '浅色', 
            dark: '深色',
        },
        themeDescriptions: {
            adaptive: '跟随系统设置',
            light: '始终使用浅色主题',
            dark: '始终使用深色主题',
        },
        chat: '聊天',
        chatDescription: '自定义聊天消息外观',
        sessionStatusBar: '会话状态信息',
        sessionStatusBarDescription: '选择分支、模型、工作量和上下文的显示位置',
        sessionStatusDisplayOptions: {
            hidden: '隐藏',
            above: '输入框上方',
            below: '输入框下方',
        },
        usageLimitShowRemaining: '显示剩余额度',
        usageLimitShowRemainingDescription: '额度指示器显示剩余量，而不是已用量',
        userMessageBubbleColor: '用户气泡颜色',
        userMessageBubbleColorDescription: '让您的消息在长聊天中更容易找到',
        userMessageBubbleColorOptions: {
            blue: '蓝色',
            green: '绿色',
            purple: '紫色',
            rose: '玫瑰色',
            sand: '沙色',
            gray: '灰色',
        },
        display: '显示',
        displayDescription: '控制布局和间距',
        compactToolCalls: '紧凑显示工具调用',
        compactToolCallsDescription: '将非交互式工具调用显示为单行；打开该行可查看详情',
        inlineToolCalls: '内联工具调用',
        inlineToolCallsDescription: '在聊天消息中直接显示工具调用',
        expandTodoLists: '展开待办列表',
        expandTodoListsDescription: '显示所有待办事项而不仅仅是变更',
        showLineNumbersInDiffs: '在差异中显示行号',
        showLineNumbersInDiffsDescription: '在代码差异中显示行号',
        showLineNumbersInToolViews: '在工具视图中显示行号',
        showLineNumbersInToolViewsDescription: '在工具视图差异中显示行号',
        wrapLinesInDiffs: '在差异中换行',
        wrapLinesInDiffsDescription: '在差异视图中换行显示长行而不是水平滚动',
        diffStyle: '差异视图',
        diffStyleDescription: '以单列（unified）或并排（split）显示差异。split 视图仅在 Web 上可用。',
        diffStyleOptions: {
            unified: 'Unified',
            split: 'Split',
        },
        alwaysShowContextSize: '始终显示上下文大小',
        alwaysShowContextSizeDescription: '即使未接近限制时也显示上下文使用情况',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: '实验功能',
        experimentsDescription: '启用仍在开发中的实验功能。这些功能可能不稳定或会在没有通知的情况下改变。',
        experimentalFeatures: '实验功能',
        experimentalFeaturesEnabled: '实验功能已启用',
        experimentalFeaturesDisabled: '仅使用稳定功能',
        webFeatures: 'Web 功能',
        webFeaturesDescription: '仅在应用的 Web 版本中可用的功能。',
        enterToSend: '回车发送',
        enterToSendEnabled: '按回车发送（Shift+回车换行）',
        enterToSendDisabled: '回车换行',
        commandPalette: '命令面板',
        commandPaletteEnabled: '按 ⌘K 打开',
        commandPaletteDisabled: '快速命令访问已禁用',
        markdownCopyV2: 'Markdown 复制 v2',
        markdownCopyV2Subtitle: '长按打开复制模态框',
        hideInactiveSessions: '隐藏非活跃会话',
        hideInactiveSessionsSubtitle: '仅在列表中显示活跃的聊天',
        groupToolCalls: '分组工具调用',
        groupToolCallsSubtitle: '将连续的工具调用折叠到一个容器中',
        privacy: '隐私',
        privacyDescription: '完全禁用所有分析和遥测。不会向 PostHog 或任何其他跟踪服务发送数据。',
        disableAnalytics: '禁用分析',
        analyticsDisabled: '所有跟踪和遥测已禁用',
        analyticsEnabled: '匿名使用分析已启用',
        imageUpload: '图片上传',
        imageUploadSubtitle: '将图片附加到消息中，以便受支持的代理进行分析',
    },

    errors: {
        networkError: '发生网络错误',
        serverError: '发生服务器错误',
        unknownError: '发生未知错误',
        connectionTimeout: '连接超时',
        authenticationFailed: '认证失败',
        permissionDenied: '权限被拒绝',
        fileNotFound: '文件未找到',
        invalidFormat: '格式无效',
        operationFailed: '操作失败',
        tryAgain: '请重试',
        contactSupport: '如果问题持续存在，请联系支持',
        sessionNotFound: '会话未找到',
        voiceSessionFailed: '启动语音会话失败',
        voiceServiceUnavailable: '语音服务暂时不可用',
        voiceLimitReachedTitle: '已达语音上限',
        voiceHardLimitReached: ({ hours }: { hours: number }) => `您本月已使用超过 ${hours} 小时的语音。这是允许的最大用量。您可以在语音设置中配置自己的 ElevenLabs 代理，以使用您自己的配额。`,
        voiceConversationLimitReached: '您本月已达到语音对话的最大次数。我们未来可能会添加按需语音使用功能——如果您遇到此限制，请在 github.com/nicepkg/happy/issues 提交 issue。',
        oauthInitializationFailed: '初始化 OAuth 流程失败',
        tokenStorageFailed: '存储认证令牌失败',
        oauthStateMismatch: '安全验证失败。请重试',
        tokenExchangeFailed: '交换授权码失败',
        oauthAuthorizationDenied: '授权被拒绝',
        webViewLoadFailed: '加载认证页面失败',
        failedToLoadProfile: '无法加载用户资料',
        userNotFound: '未找到用户',
        sessionDeleted: '会话已被删除',
        sessionDeletedDescription: '此会话已被永久删除',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} 必须在 ${min} 和 ${max} 之间`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `${seconds} 秒后重试`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (错误 ${code})`,
    },

    newSession: {
        title: '开始新会话',
        machineOffline: '设备离线',
        switchMachinesHint: '• 点击上方的设备来切换设备',
    },

    sessionHistory: {
        // Used by session history screen
        empty: '未找到会话',
        daysAgo: ({ count }: { count: number }) => `${count} 天前`,
    },

    session: {
        inputPlaceholder: '输入消息...',
        inactiveArchived: '此会话处于非活动状态。',
        resumeFromTerminal: '要从终端恢复它：',
        newChat: '新对话',
        statusBarContext: '上下文',
        statusBarPathTitle: '工作目录',
        forkAction: '分叉会话',
        forkSubtitle: '在相同上下文中开启新会话继续',
        duplicateAction: '从消息处复制…',
        duplicateSubtitle: '回到选定位置重新尝试',
        forkFromHere: '从此处分叉',
        duplicateSheetTitle: '选择回退点',
        duplicateSheetSubtitle: '新会话将保留所选轮次完整内容（你的消息与智能体的回复），并丢弃其后的所有消息。',
        duplicateSheetConfirm: '复制',
        duplicateSheetEmpty: '此会话还没有可回退的消息。',
        duplicateRowDisabled: '此消息不能作为回退点。',
        forkedFromLabel: '分叉自',
        forkedFromSubtitle: '打开分叉来源的会话',
        forkErrorOffline: '机器离线。仅当会话所在的机器在线时才能分叉。',
        forkErrorMissingUuid: '选定的回退点已不存在于源会话中 — 请尝试不截断地分叉。',
        forkErrorMissingMetadata: '缺少分叉所需的会话元数据。',
        forkErrorGeneric: '分叉会话失败。',
        forkClaudeOnly: '目前仅支持 Claude 会话的分叉。',
    },

    commandPalette: {
        placeholder: '输入命令或搜索...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: '终止会话',
        killSessionConfirm: '您确定要终止此会话吗？',
        archiveSession: '归档会话',
        archiveSessionConfirm: '您确定要归档此会话吗？',
        happySessionIdCopied: 'Happy 会话 ID 已复制到剪贴板',
        failedToCopySessionId: '复制 Happy 会话 ID 失败',
        happySessionId: 'Happy 会话 ID',
        claudeCodeSessionId: 'Claude Code 会话 ID',
        claudeCodeSessionIdCopied: 'Claude Code 会话 ID 已复制到剪贴板',
        codexThreadId: 'Codex 线程 ID',
        codexThreadIdCopied: 'Codex 线程 ID 已复制到剪贴板',
        aiProvider: 'AI 提供商',
        failedToCopyClaudeCodeSessionId: '复制 Claude Code 会话 ID 失败',
        failedToCopyCodexThreadId: '复制 Codex 线程 ID 失败',
        metadataCopied: '元数据已复制到剪贴板',
        failedToCopyMetadata: '复制元数据失败',
        failedToKillSession: '终止会话失败',
        failedToArchiveSession: '归档会话失败',
        connectionStatus: '连接状态',
        created: '创建时间',
        lastUpdated: '最后更新',
        sequence: '序列',
        quickActions: '快速操作',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionNeedsHappyAgent: 'Resume is unavailable on this machine. Run `happy-agent auth login` to enable it.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Claude or Codex identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        killSessionSubtitle: '立即终止会话',
        archiveSessionSubtitle: '归档此会话并停止它',
        metadata: '元数据',
        host: '主机',
        path: '路径',
        operatingSystem: '操作系统',
        processId: '进程 ID',
        happyHome: 'Happy 主目录',
        copyMetadata: '复制元数据',
        agentState: 'Agent 状态',
        controlledByUser: '用户控制',
        pendingRequests: '待处理请求',
        activity: '活动',
        thinking: '思考中',
        thinkingSince: '思考开始时间',
        cliVersion: 'CLI 版本',
        cliVersionOutdated: '需要更新 CLI',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `已安装版本 ${currentVersion}。请更新到 ${requiredVersion} 或更高版本`,
        updateCliInstructions: '请运行 npm install -g happy@latest',
        deleteSession: '删除会话',
        deleteSessionSubtitle: '永久删除此会话',
        deleteSessionConfirm: '永久删除会话？',
        deleteSessionWarning: '此操作无法撤销。与此会话相关的所有消息和数据将被永久删除。',
        failedToDeleteSession: '删除会话失败',
        sessionDeleted: '会话删除成功',
        worktreeCleanupTitle: '删除 Worktree？',
        worktreeCleanupMessage: 'Worktree 没有未提交的更改。是否要删除 Worktree 文件？',
        worktreeCleanupDelete: '删除 Worktree',
        worktreeCleanupKeep: '保留文件',

    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: '准备开始编程？',
            installCli: '安装 Happy CLI',
            runIt: '运行它',
            scanQrCode: '扫描二维码',
            openCamera: '打开相机',
        },
        agentGoalBar: {
            currentGoal: '当前目标',
            accessibilityLabel: ({ goal }: { goal: string }) => `当前目标：${goal}`,
            clearGoal: '清除目标',
            stopGoal: '停止目标',
            editGoal: '编辑目标',
        },
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `上下文 ${used}/${total} 个令牌，${percent}%`,
            limitFiveHour: '5 小时额度',
            limitSevenDay: '7 天额度',
            limitResets: ({ time }: { time: string }) => `${time} 重置`,
            limitAsOf: ({ age }: { age: string }) => `数据为 ${age} 前`,
            limitRemaining: ({ percent }: { percent: number }) => `剩余 ${percent}%`,
        },
    },

    agentInput: {
        permissionMode: {
            title: '权限模式',
            default: '默认',
            acceptEdits: '接受编辑',
            plan: '计划模式',
            dontAsk: '不再询问',
            bypassPermissions: 'Yolo 模式',
            badgeAcceptAllEdits: '接受所有编辑',
            badgeBypassAllPermissions: '绕过所有权限',
            badgePlanMode: '计划模式',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
            openclaw: 'OpenClaw',
        },
        model: {
            title: '模型',
            configureInCli: '在 CLI 设置中配置模型',
        },
        effort: {
            title: '工作量',
        },
        codexPermissionMode: {
            title: 'CODEX 权限模式',
            default: 'CLI 设置',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            defaultDescription: '不受信任的命令前询问',
            readOnlyDescription: '禁止写入',
            safeYoloDescription: '无需确认，工作区沙盒',
            yoloDescription: '无需确认，完全访问',
            badgeReadOnly: 'Read Only Mode',
            badgeSafeYolo: 'Safe YOLO',
            badgeYolo: 'YOLO',
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
            title: 'GEMINI 权限模式',
            default: '默认',
            autoEdit: '自动编辑',
            yolo: 'YOLO',
            plan: '计划',
            badgeAutoEdit: '自动编辑',
            badgeYolo: 'YOLO',
            badgePlan: '计划',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `剩余 ${percent}%`,
        },
        suggestion: {
            fileLabel: '文件',
            folderLabel: '文件夹',
        },
        noMachinesAvailable: '无设备',
    },

    machineLauncher: {
        showLess: '显示更少',
        showAll: ({ count }: { count: number }) => `显示全部 (${count} 个路径)`,
        enterCustomPath: '输入自定义路径',
        offlineUnableToSpawn: '无法生成新会话，已离线',
    },

    agentQuestion: {
        title: "问题",
        submit: "发送回答",
        chooseMultiple: "选择所有适用项",
        ownAnswer: "自定义回答",
        ownAnswerPlaceholder: "输入你的回答",
        submitFailed: "无法发送你的回答",
        dismiss: "忽略",
        unsupportedTitle: "不支持的请求",
        unsupportedDescription: ({ kind }: { kind: string }) => `此版本的 Happy 无法显示「${kind}」请求。请更新应用后回复。`,
        moreQuestions: ({ count }: { count: number }) =>
            count === 1 ? "还有 1 个问题" : `${count} 个问题`,
    },

    sidebar: {
        sessionsTitle: 'Happy',
        showArchived: '显示已归档',
        hideArchived: '隐藏已归档',
        newSession: '新建会话',
        projects: "项目",
    },

    zen: {
        toggle: '禅模式',
    },

    toolView: {
        input: '输入',
        output: '输出',
    },

    toolGroup: {
        editedFile: 'Edited file',
        editedFiles: ({ count }: { count: number }) => `编辑了 ${count} 个文件`,
        readFiles: ({ count }: { count: number }) => `读取了 ${count} 个文件`,
        ranCommands: ({ count }: { count: number }) => `执行了 ${count} 个命令`,
        searched: ({ count }: { count: number }) => `搜索了 ${count} 次`,
        fetchedUrls: ({ count }: { count: number }) => `获取了 ${count} 个 URL`,
        ranTasks: ({ count }: { count: number }) => `执行了 ${count} 个任务`,
        usedTools: ({ count }: { count: number }) => `使用了 ${count} 个工具`,
        workedFor: ({ duration }: { duration: string }) => `Worked ${duration}`,
    },

    tools: {
        fullView: {
            description: '描述',
            inputParams: '输入参数',
            output: '输出',
            error: '错误',
            completed: '工具已成功完成',
            noOutput: '未产生输出',
            running: '工具正在运行...',
            rawJsonDevMode: '原始 JSON（开发模式）',
        },
        taskView: {
            initializing: '正在初始化 agent...',
            moreTools: ({ count }: { count: number }) => `+${count} 个更多${plural({ count, singular: '工具', plural: '工具' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `编辑 ${index}/${total}`,
            replaceAll: '全部替换',
        },
        names: {
            task: '任务',
            terminal: '终端',
            searchFiles: '搜索文件',
            search: '搜索',
            searchContent: '搜索内容',
            listFiles: '列出文件',
            planProposal: '计划建议',
            readFile: '读取文件',
            editFile: '编辑文件',
            writeFile: '写入文件',
            fetchUrl: '获取 URL',
            readNotebook: '读取 Notebook',
            editNotebook: '编辑 Notebook',
            todoList: '待办列表',
            webSearch: 'Web 搜索',
            reasoning: '推理',
            applyChanges: '更新文件',
            viewDiff: '当前文件更改',
            question: '问题',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `终端(命令: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `搜索(模式: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `搜索(路径: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `获取 URL(网址: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `编辑 Notebook(文件: ${path}, 模式: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `待办列表(数量: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Web 搜索(查询: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(模式: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} 处编辑)`,
            readingFile: ({ file }: { file: string }) => `正在读取 ${file}`,
            writingFile: ({ file }: { file: string }) => `正在写入 ${file}`,
            modifyingFile: ({ file }: { file: string }) => `正在修改 ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `正在修改 ${count} 个文件`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} 和其他 ${count} 个`,
            showingDiff: '显示更改',
        },
        askUserQuestion: {
            submit: '提交答案',
            multipleQuestions: ({ count }: { count: number }) => `${count} 个问题`,
            other: '其他',
            otherDescription: '输入您自己的答案',
            otherPlaceholder: '输入您的答案...',
        }
    },

    files: {
        changes: '更改',
        searchPlaceholder: '搜索文件...',
        detachedHead: '游离 HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} 已暂存 • ${unstaged} 未暂存`,
        notRepo: '不是 git 仓库',
        notUnderGit: '此目录不在 git 版本控制下',
        searching: '正在搜索文件...',
        noFilesFound: '未找到文件',
        noFilesInProject: '项目中没有文件',
        tryDifferentTerm: '尝试不同的搜索词',
        searchResults: ({ count }: { count: number }) => `搜索结果 (${count})`,
        projectRoot: '项目根目录',
        stagedChanges: ({ count }: { count: number }) => `已暂存的更改 (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `未暂存的更改 (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `正在加载 ${fileName}...`,
        binaryFile: '二进制文件',
        cannotDisplayBinary: '无法显示二进制文件内容',
        diff: '差异',
        file: '文件',
        fileEmpty: '文件为空',
        noChanges: '没有要显示的更改',
        noChangesTitle: '没有更改',
        noChangesSubtitle: '工作区是干净的',
        deleted: '已删除',
        changedFiles: ({ count }: { count: number }) => `${count} 个已更改的文件`,
        allFiles: '所有文件',
        addPanel: '添加面板',
        closePanel: '关闭面板',
        editFile: '编辑',
        saveFile: '保存',
        failedToRead: '读取文件失败',
        failedToSave: '保存文件失败',
        fileConflict: '文件冲突',
        fileConflictDescription: '编辑期间文件已在设备上被修改。重新加载以查看最新版本。',
        reload: '重新加载',
        overwrite: '覆盖',
    },
    sideChat: {
        panelTitle: '侧边聊天',
        emptyTitle: '开始侧边聊天',
        emptySubtitle: '在一旁向智能体提问。它会继承此聊天的上下文，但保持独立——这里的任何操作都不会影响主对话。',
        startButton: '开始侧边聊天',
        creating: '正在开始侧边聊天…',
        unavailable: '此会话暂时无法开始侧边聊天——请等待智能体上线。',
        composerPlaceholder: '给侧边聊天发消息…',
        expand: '全屏打开',
        tabLabel: ({ index }: { index: number }) => `侧边聊天 ${index}`,
        newChat: '新建侧边聊天',
        close: '关闭侧边聊天',
    },



    settingsLanguage: {
        // Language settings screen
        title: '语言',
        description: '选择您希望应用界面使用的语言。此设置将在您的所有设备间同步。',
        currentLanguage: '当前语言',
        automatic: '自动',
        automaticSubtitle: '从设备设置中检测',
        needsRestart: '语言已更改',
        needsRestartMessage: '应用需要重启以应用新的语言设置。',
        restartNow: '立即重启',
    },


    updateBanner: {
        updateAvailable: '有可用更新',
        pressToApply: '点击应用更新',
        whatsNew: "更新内容",
        seeLatest: '查看最新更新和改进',
        nativeUpdateAvailable: '应用更新可用',
        tapToUpdateAppStore: '点击在 App Store 中更新',
        tapToUpdatePlayStore: '点击在 Play Store 中更新',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `版本 ${version}`,
        noEntriesAvailable: '没有可用的更新日志条目。',
    },


    modals: {
        // Used across connect flows and settings
        authenticateTerminal: '认证终端',
        pasteUrlFromTerminal: '粘贴来自您终端的认证 URL',
        deviceLinkedSuccessfully: '设备链接成功',
        terminalConnectedSuccessfully: '终端连接成功',
        invalidAuthUrl: '无效的认证 URL',
        failedToConnectTerminal: '连接终端失败',
        cameraPermissionsRequiredToConnectTerminal: '连接终端需要相机权限',
        failedToLinkDevice: '链接设备失败',
        cameraPermissionsRequiredToScanQr: '扫描二维码需要相机权限'
    },

    navigation: {
        // Navigation titles and screen headers
        whatsNew: "更新日志",
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Codex 和 Claude Code 移动客户端',
        subtitle: '端到端加密，您的账户仅存储在您的设备上。',
        createAccount: '创建账户',
        linkOrRestoreAccount: '链接或恢复账户',
        loginWithMobileApp: '使用移动应用登录',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: '喜欢这个应用吗？',
        feedbackPrompt: "我们很希望听到您的反馈！",
        yesILoveIt: '是的，我喜欢！',
        notReally: '不太喜欢'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} 已复制到剪贴板`
    },

    machine: {
        launchNewSessionInDirectory: '在目录中启动新会话',
        offlineUnableToSpawn: '设备离线时无法启动',
        offlineHelp: '• 确保您的计算机在线\n• 运行 `happy daemon status` 进行诊断\n• 您是否在运行最新的 CLI 版本？请使用 `npm install -g happy@latest` 升级',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `已切换到 ${mode} 模式`,
        unknownEvent: '未知事件',
        usageLimitUntil: ({ time }: { time: string }) => `使用限制到 ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: '未知时间',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: '是，并且本次会话不再询问',
            stopAndExplain: '停止，并说明该做什么',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: '是，允许本次会话的所有编辑',
            yesAllowEverything: '是，允许本次会话的所有操作',
            yesForTool: '是，不再询问此工具',
            noTellClaude: '否，提供反馈',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: '选择文本范围',
        title: '选择文本',
        noTextProvided: '未提供文本',
        textNotFound: '文本未找到或已过期',
        textCopied: '文本已复制到剪贴板',
        failedToCopy: '复制文本到剪贴板失败',
        noTextToCopy: '没有可复制的文本',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: '代码已复制',
        copyFailed: '复制失败',
        mermaidRenderFailed: '渲染 mermaid 图表失败',
    },




    beelineIdentity: {
        handleCeremonyLabel: '身份 · 用户名仪式',
        handleInvalidTitle: '用户名不可用',
        handleInvalidMessage: '请使用 3–30 个小写字母、数字或连字符。',
        handleTakenTitle: '用户名已被占用',
        handleClaimFailedTitle: '用户名未领取',
        handleTakenMessage: ({ handle }: { handle: string }) => `@${handle} 已属于其他人。请选择其他用户名。`,
        handleCeremonyTitle: '选择你的用户名',
        handleCeremonyBody: '此名称会绑定到你的密钥，并成为你在各处经过验证的 Beeline 身份。',
        handleAccessibility: '选择你的 Beeline 用户名',
        handlePlaceholder: 'ada-labs',
        handleRules: '3–30 · a–z · 0–9 · 连字符',
        claimHandle: '领取用户名',
        githubLinkedNotice: 'GitHub 已关联到此密钥。你的身份和历史记录保持不变。',
        githubRenameNotice: ({ handle }: { handle: string }) => `你经过验证的用户名现在是 @${handle}。`,
        claimStatusInvalid: '请使用 3-30 个小写字母、数字或连字符',
        hostedHandleClaimBody: '在 usebeeline.app 领取你的验证用户名，先到先得。',
        linkGithub: '将 GitHub 关联到此密钥',
        renameOffer: ({ current, github }: { current: string; github: string }) => `保留 @${current}，或一次性改用你的 GitHub 用户名：@${github}。`,
        useGithubHandle: ({ handle }: { handle: string }) => `使用 @${handle}`,
    },

    imageUpload: {
        permissionTitle: '访问照片库',
        permissionMessage: '允许访问您的照片库以在消息中附加图片。',
        limitTitle: '已达到图片限制',
        limitMessage: ({ max }: { max: number }) => `每条消息最多可附加 ${max} 张图片。`,
        fileTooLargeTitle: '文件过大',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}"超过了 ${maxMb}MB 的限制，未能添加。`,
        uploadFailedTitle: '上传失败',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? '一张图片上传失败，未发送。'
            : `${count} 张图片上传失败，未发送。`,
        notSupportedTitle: '不支持图片',
        notSupportedMessage: '此代理不支持图片附件。图片未发送。',
    },

} as const;
