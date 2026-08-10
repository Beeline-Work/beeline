/**
 * Chinese (Traditional) translations for the Happy app
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

export const zhHant: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: '終端',
        settings: '設定',
    },


    common: {
        // Simple string constants
        cancel: '取消',
        authenticate: '驗證',
        save: '儲存',
        saveAs: '另存為',
        error: '錯誤',
        success: '成功',
        ok: '確定',
        continue: '繼續',
        back: '返回',
        create: '建立',
        rename: '重新命名',
        reset: '重設',
        logout: '登出',
        yes: '是',
        no: '否',
        discard: '放棄',
        version: '版本',
        copied: '已複製',
        copy: '複製',
        scanning: '掃描中...',
        urlPlaceholder: 'https://example.com',
        home: '首頁',
        message: '訊息',
        files: '檔案',
        fileViewer: '檔案檢視器',
        loading: '載入中...',
        retry: '重試',
        delete: '刪除',
        optional: '選填',
    },

    profile: {
        userProfile: '使用者資料',
        details: '詳情',
        firstName: '名',
        lastName: '姓',
        username: '使用者名稱',
        status: '狀態',
    },

    status: {
        connected: '已連線',
        connecting: '連線中',
        disconnected: '已中斷連線',
        error: '錯誤',
        online: '線上',
        offline: '離線',
        lastSeen: ({ time }: { time: string }) => `最後活躍時間 ${time}`,
        permissionRequired: '需要權限',
        activeNow: '目前活躍',
        unknown: '未知',
        unread: '新結果',
    },

    time: {
        justNow: '剛剛',
        minutesAgo: ({ count }: { count: number }) => `${count} 分鐘前`,
        hoursAgo: ({ count }: { count: number }) => `${count} 小時前`,
        daysAgo: ({ count }: { count: number }) => `${count} 天前`,
    },

    connect: {
        enterUrlManually: '手動輸入 URL',
    },

    settings: {
        title: '設定',
        github: 'GitHub',
        features: '功能',
        appearance: '外觀',
        appearanceSubtitle: '自訂應用程式外觀',
        featuresTitle: '功能',
        featuresSubtitle: '啟用或停用應用程式功能',
        about: '關於',
        aboutFooter: 'Happy Coder 是一個 Codex 和 Claude Code 行動用戶端。它採用端對端加密，您的帳戶僅儲存在本機裝置上。與 Anthropic 無關聯。',
        whatsNew: '更新日誌',
        whatsNewSubtitle: '查看最新更新和改進',
        reportIssue: '回報問題',
        privacyPolicy: '隱私權政策',
        termsOfService: '服務條款',
        eula: '終端使用者授權協議',
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} 已${enabled ? '啟用' : '停用'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: '主題',
        themeDescription: '選擇您喜歡的配色方案',
        themeOptions: {
            adaptive: '自適應',
            light: '淺色',
            dark: '深色',
        },
        themeDescriptions: {
            adaptive: '跟隨系統設定',
            light: '始終使用淺色主題',
            dark: '始終使用深色主題',
        },
        chat: '聊天',
        chatDescription: '自訂聊天訊息外觀',
        sessionStatusBar: '工作階段狀態資訊',
        sessionStatusBarDescription: '選擇分支、模型、工作量和上下文的顯示位置',
        sessionStatusDisplayOptions: {
            hidden: '隱藏',
            above: '輸入框上方',
            below: '輸入框下方',
        },
        usageLimitShowRemaining: '顯示剩餘額度',
        usageLimitShowRemainingDescription: '額度指示器顯示剩餘量，而非已用量',
        userMessageBubbleColor: '使用者氣泡顏色',
        userMessageBubbleColorDescription: '讓您的訊息在長聊天中更容易找到',
        userMessageBubbleColorOptions: {
            blue: '藍色',
            green: '綠色',
            purple: '紫色',
            rose: '玫瑰色',
            sand: '沙色',
            gray: '灰色',
        },
        display: '顯示',
        displayDescription: '控制版面配置和間距',
        compactToolCalls: '精簡顯示工具呼叫',
        compactToolCallsDescription: '將非互動式工具呼叫顯示為單行；開啟該行可查看詳細資訊',
        inlineToolCalls: '內嵌工具呼叫',
        inlineToolCallsDescription: '在聊天訊息中直接顯示工具呼叫',
        expandTodoLists: '展開待辦清單',
        expandTodoListsDescription: '顯示所有待辦事項而不僅僅是變更',
        showLineNumbersInDiffs: '在差異中顯示行號',
        showLineNumbersInDiffsDescription: '在程式碼差異中顯示行號',
        showLineNumbersInToolViews: '在工具檢視中顯示行號',
        showLineNumbersInToolViewsDescription: '在工具檢視差異中顯示行號',
        wrapLinesInDiffs: '在差異中換行',
        wrapLinesInDiffsDescription: '在差異檢視中換行顯示長行而不是水平捲動',
        diffStyle: '差異檢視',
        diffStyleDescription: '以單欄（unified）或並排（split）顯示差異。split 檢視僅在 Web 上可用。',
        diffStyleOptions: {
            unified: 'Unified',
            split: 'Split',
        },
        alwaysShowContextSize: '始終顯示上下文大小',
        alwaysShowContextSizeDescription: '即使未接近限制時也顯示上下文使用情況',
        avatarStyle: '頭像風格',
        avatarStyleDescription: '選擇工作階段頭像外觀',
        avatarOptions: {
            pixelated: '像素化',
            gradient: '漸層',
            brutalist: '粗獷風格',
        },
        showFlavorIcons: '顯示 AI 提供者圖示',
        showFlavorIconsDescription: '在工作階段頭像上顯示 AI 提供者圖示',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: '實驗功能',
        experimentsDescription: '啟用仍在開發中的實驗功能。這些功能可能不穩定或會在沒有通知的情況下改變。',
        experimentalFeatures: '實驗功能',
        experimentalFeaturesEnabled: '實驗功能已啟用',
        experimentalFeaturesDisabled: '僅使用穩定功能',
        webFeatures: 'Web 功能',
        webFeaturesDescription: '僅在應用程式的 Web 版本中可用的功能。',
        enterToSend: 'Enter 鍵傳送',
        enterToSendEnabled: '按 Enter 傳送（Shift+Enter 換行）',
        enterToSendDisabled: 'Enter 鍵插入換行',
        commandPalette: '命令面板',
        commandPaletteEnabled: '按 ⌘K 開啟',
        commandPaletteDisabled: '快速命令存取已停用',
        markdownCopyV2: 'Markdown 複製 v2',
        markdownCopyV2Subtitle: '長按開啟複製強制回應視窗',
        hideInactiveSessions: '隱藏非活躍工作階段',
        hideInactiveSessionsSubtitle: '僅在清單中顯示活躍的聊天',
        groupToolCalls: '分組工具呼叫',
        groupToolCallsSubtitle: '將連續的工具呼叫摺疊到單一容器中',
        privacy: '隱私',
        privacyDescription: '完全停用所有分析和遙測。不會向 PostHog 或任何其他追蹤服務傳送資料。',
        disableAnalytics: '停用分析',
        analyticsDisabled: '所有追蹤和遙測已停用',
        analyticsEnabled: '匿名使用分析已啟用',
        imageUpload: '圖片上傳',
        imageUploadSubtitle: '將圖片附加到訊息中，讓支援的代理分析',
    },

    errors: {
        networkError: '發生網路錯誤',
        serverError: '發生伺服器錯誤',
        unknownError: '發生未知錯誤',
        connectionTimeout: '連線逾時',
        authenticationFailed: '驗證失敗',
        permissionDenied: '權限被拒絕',
        fileNotFound: '檔案未找到',
        invalidFormat: '格式無效',
        operationFailed: '操作失敗',
        tryAgain: '請重試',
        contactSupport: '如果問題持續存在，請聯絡支援',
        sessionNotFound: '工作階段未找到',
        voiceSessionFailed: '啟動語音工作階段失敗',
        voiceServiceUnavailable: '語音服務暫時無法使用',
        voiceLimitReachedTitle: '已達語音上限',
        voiceHardLimitReached: ({ hours }: { hours: number }) => `您本月已使用超過 ${hours} 小時的語音。這是允許的最大用量。您可以在語音設定中配置自己的 ElevenLabs 代理，以使用您自己的配額。`,
        voiceConversationLimitReached: '您本月已達到語音對話的最大次數。我們未來可能會新增按需語音使用功能——如果您遇到此限制，請在 github.com/nicepkg/happy/issues 提交 issue。',
        oauthInitializationFailed: '初始化 OAuth 流程失敗',
        tokenStorageFailed: '儲存驗證權杖失敗',
        oauthStateMismatch: '安全驗證失敗。請重試',
        tokenExchangeFailed: '交換授權碼失敗',
        oauthAuthorizationDenied: '授權被拒絕',
        webViewLoadFailed: '載入驗證頁面失敗',
        failedToLoadProfile: '無法載入使用者資料',
        userNotFound: '未找到使用者',
        sessionDeleted: '工作階段已被刪除',
        sessionDeletedDescription: '此工作階段已被永久刪除',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} 必須在 ${min} 和 ${max} 之間`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `${seconds} 秒後重試`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (錯誤 ${code})`,
    },

    newSession: {
        title: '開始新工作階段',
        machineOffline: '裝置離線',
        switchMachinesHint: '• 點擊上方的裝置來切換裝置',
    },

    sessionHistory: {
        // Used by session history screen
        empty: '未找到工作階段',
        daysAgo: ({ count }: { count: number }) => `${count} 天前`,
    },

    session: {
        inputPlaceholder: '輸入訊息...',
        inactiveArchived: '此會話處於非活動狀態。',
        resumeFromTerminal: '若要從終端恢復它：',
        newChat: '新對話',
        statusBarContext: '上下文',
        statusBarPathTitle: '工作目錄',
        forkAction: '分叉會話',
        forkSubtitle: '在相同上下文中開啟新會話繼續',
        duplicateAction: '從訊息處複製…',
        duplicateSubtitle: '回到選定位置重新嘗試',
        forkFromHere: '從此處分叉',
        duplicateSheetTitle: '選擇回退點',
        duplicateSheetSubtitle: '新會話將保留所選輪次完整內容（你的訊息與智能體的回覆），並丟棄其後的所有訊息。',
        duplicateSheetConfirm: '複製',
        duplicateSheetEmpty: '此會話還沒有可回退的訊息。',
        duplicateRowDisabled: '此訊息不能作為回退點。',
        forkedFromLabel: '分叉自',
        forkedFromSubtitle: '開啟分叉來源的會話',
        forkErrorOffline: '機器離線。僅當會話所在的機器在線時才能分叉。',
        forkErrorMissingUuid: '選定的回退點已不存在於來源會話中 — 請嘗試不截斷地分叉。',
        forkErrorMissingMetadata: '缺少分叉所需的會話元資料。',
        forkErrorGeneric: '分叉會話失敗。',
        forkClaudeOnly: '目前僅支援 Claude 會話的分叉。',
    },

    commandPalette: {
        placeholder: '輸入命令或搜尋...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: '終止工作階段',
        killSessionConfirm: '您確定要終止此工作階段嗎？',
        archiveSession: '封存工作階段',
        archiveSessionConfirm: '您確定要封存此工作階段嗎？',
        happySessionIdCopied: 'Happy 工作階段 ID 已複製到剪貼簿',
        failedToCopySessionId: '複製 Happy 工作階段 ID 失敗',
        happySessionId: 'Happy 工作階段 ID',
        claudeCodeSessionId: 'Claude Code 工作階段 ID',
        claudeCodeSessionIdCopied: 'Claude Code 工作階段 ID 已複製到剪貼簿',
        codexThreadId: 'Codex 執行緒 ID',
        codexThreadIdCopied: 'Codex 執行緒 ID 已複製到剪貼簿',
        aiProvider: 'AI 提供者',
        failedToCopyClaudeCodeSessionId: '複製 Claude Code 工作階段 ID 失敗',
        failedToCopyCodexThreadId: '複製 Codex 執行緒 ID 失敗',
        metadataCopied: '中繼資料已複製到剪貼簿',
        failedToCopyMetadata: '複製中繼資料失敗',
        failedToKillSession: '終止工作階段失敗',
        failedToArchiveSession: '封存工作階段失敗',
        connectionStatus: '連線狀態',
        created: '建立時間',
        lastUpdated: '最後更新',
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
        killSessionSubtitle: '立即終止工作階段',
        archiveSessionSubtitle: '封存此工作階段並停止它',
        metadata: '中繼資料',
        host: '主機',
        path: '路徑',
        operatingSystem: '作業系統',
        processId: '處理程序 ID',
        happyHome: 'Happy 主目錄',
        copyMetadata: '複製中繼資料',
        agentState: 'Agent 狀態',
        controlledByUser: '使用者控制',
        pendingRequests: '待處理請求',
        activity: '活動',
        thinking: '思考中',
        thinkingSince: '思考開始時間',
        cliVersion: 'CLI 版本',
        cliVersionOutdated: '需要更新 CLI',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `已安裝版本 ${currentVersion}。請更新到 ${requiredVersion} 或更高版本`,
        updateCliInstructions: '請執行 npm install -g happy@latest',
        deleteSession: '刪除工作階段',
        deleteSessionSubtitle: '永久刪除此工作階段',
        deleteSessionConfirm: '永久刪除工作階段？',
        deleteSessionWarning: '此操作無法復原。與此工作階段相關的所有訊息和資料將被永久刪除。',
        failedToDeleteSession: '刪除工作階段失敗',
        sessionDeleted: '工作階段刪除成功',
        worktreeCleanupTitle: '刪除 Worktree？',
        worktreeCleanupMessage: 'Worktree 沒有未提交的變更。是否要刪除 Worktree 檔案？',
        worktreeCleanupDelete: '刪除 Worktree',
        worktreeCleanupKeep: '保留檔案',

    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: '準備開始寫程式？',
            installCli: '安裝 Happy CLI',
            runIt: '執行它',
            scanQrCode: '掃描 QR Code',
            openCamera: '開啟相機',
        },
        agentGoalBar: {
            currentGoal: '目前目標',
            accessibilityLabel: ({ goal }: { goal: string }) => `目前目標：${goal}`,
            clearGoal: '清除目標',
            stopGoal: '停止目標',
            editGoal: '編輯目標',
        },
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `上下文 ${used}/${total} 個權杖，${percent}%`,
            limitFiveHour: '5 小時額度',
            limitSevenDay: '7 天額度',
            limitResets: ({ time }: { time: string }) => `${time} 重置`,
            limitAsOf: ({ age }: { age: string }) => `數據為 ${age} 前`,
            limitRemaining: ({ percent }: { percent: number }) => `剩餘 ${percent}%`,
        },
    },

    agentInput: {
        permissionMode: {
            title: '權限模式',
            default: '預設',
            acceptEdits: '接受編輯',
            plan: '計畫模式',
            dontAsk: '不再詢問',
            bypassPermissions: 'Yolo 模式',
            badgeAcceptAllEdits: '接受所有編輯',
            badgeBypassAllPermissions: '繞過所有權限',
            badgePlanMode: '計畫模式',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
            openclaw: 'OpenClaw',
        },
        model: {
            title: '模型',
            configureInCli: '在 CLI 設定中配置模型',
        },
        effort: {
            title: '工作量',
        },
        codexPermissionMode: {
            title: 'CODEX 權限模式',
            default: 'CLI 設定',
            readOnly: '唯讀模式',
            safeYolo: '安全 YOLO',
            yolo: 'YOLO',
            defaultDescription: '不受信任的命令前詢問',
            readOnlyDescription: '禁止寫入',
            safeYoloDescription: '無需確認，工作區沙盒',
            yoloDescription: '無需確認，完全存取',
            badgeReadOnly: '唯讀模式',
            badgeSafeYolo: '安全 YOLO',
            badgeYolo: 'YOLO',
        },
        codexModel: {
            title: 'CODEX 模型',
            gpt5CodexLow: 'gpt-5-codex low',
            gpt5CodexMedium: 'gpt-5-codex medium',
            gpt5CodexHigh: 'gpt-5-codex high',
            gpt5Minimal: 'GPT-5 極簡',
            gpt5Low: 'GPT-5 低',
            gpt5Medium: 'GPT-5 中',
            gpt5High: 'GPT-5 高',
        },
        geminiPermissionMode: {
            title: 'GEMINI 權限模式',
            default: '預設',
            autoEdit: '自動編輯',
            yolo: 'YOLO',
            plan: '計畫',
            badgeAutoEdit: '自動編輯',
            badgeYolo: 'YOLO',
            badgePlan: '計畫',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `剩餘 ${percent}%`,
        },
        suggestion: {
            fileLabel: '檔案',
            folderLabel: '資料夾',
        },
        noMachinesAvailable: '無裝置',
    },

    machineLauncher: {
        showLess: '顯示更少',
        showAll: ({ count }: { count: number }) => `顯示全部 (${count} 個路徑)`,
        enterCustomPath: '輸入自訂路徑',
        offlineUnableToSpawn: '無法生成新工作階段，已離線',
    },

    agentQuestion: {
        title: "問題",
        submit: "傳送回答",
        chooseMultiple: "選擇所有適用項",
        ownAnswer: "自訂回答",
        ownAnswerPlaceholder: "輸入你的回答",
        submitFailed: "無法傳送你的回答",
        dismiss: "忽略",
        unsupportedTitle: "不支援的請求",
        unsupportedDescription: ({ kind }: { kind: string }) => `此版本的 Happy 無法顯示「${kind}」請求。請更新應用程式後回覆。`,
        moreQuestions: ({ count }: { count: number }) =>
            count === 1 ? "還有 1 個問題" : `${count} 個問題`,
    },

    sidebar: {
        sessionsTitle: 'Happy',
        showArchived: '顯示已封存',
        hideArchived: '隱藏已封存',
        newSession: '新建對話',
        projects: "專案",
    },

    zen: {
        toggle: '禪模式',
    },

    toolView: {
        input: '輸入',
        output: '輸出',
    },

    toolGroup: {
        editedFile: 'Edited file',
        editedFiles: ({ count }: { count: number }) => `編輯了 ${count} 個檔案`,
        readFiles: ({ count }: { count: number }) => `讀取了 ${count} 個檔案`,
        ranCommands: ({ count }: { count: number }) => `執行了 ${count} 個指令`,
        searched: ({ count }: { count: number }) => `搜尋了 ${count} 次`,
        fetchedUrls: ({ count }: { count: number }) => `取得了 ${count} 個 URL`,
        ranTasks: ({ count }: { count: number }) => `執行了 ${count} 個任務`,
        usedTools: ({ count }: { count: number }) => `使用了 ${count} 個工具`,
        workedFor: ({ duration }: { duration: string }) => `Worked ${duration}`,
    },

    tools: {
        fullView: {
            description: '描述',
            inputParams: '輸入參數',
            output: '輸出',
            error: '錯誤',
            completed: '工具已成功完成',
            noOutput: '未產生輸出',
            running: '工具正在執行...',
            rawJsonDevMode: '原始 JSON（開發模式）',
        },
        taskView: {
            initializing: '正在初始化 agent...',
            moreTools: ({ count }: { count: number }) => `+${count} 個更多${plural({ count, singular: '工具', plural: '工具' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `編輯 ${index}/${total}`,
            replaceAll: '全部替換',
        },
        names: {
            task: '任務',
            terminal: '終端機',
            searchFiles: '搜尋檔案',
            search: '搜尋',
            searchContent: '搜尋內容',
            listFiles: '列出檔案',
            planProposal: '計畫建議',
            readFile: '讀取檔案',
            editFile: '編輯檔案',
            writeFile: '寫入檔案',
            fetchUrl: '獲取 URL',
            readNotebook: '讀取 Notebook',
            editNotebook: '編輯 Notebook',
            todoList: '待辦清單',
            webSearch: 'Web 搜尋',
            reasoning: '推理',
            applyChanges: '更新檔案',
            viewDiff: '目前檔案更改',
            question: '問題',
        },
        askUserQuestion: {
            submit: '提交答案',
            multipleQuestions: ({ count }: { count: number }) => `${count} 個問題`,
            other: '其他',
            otherDescription: '輸入您自己的答案',
            otherPlaceholder: '輸入您的答案...',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `終端機(命令: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `搜尋(模式: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `搜尋(路徑: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `獲取 URL(網址: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `編輯 Notebook(檔案: ${path}, 模式: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `待辦清單(數量: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Web 搜尋(查詢: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(模式: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} 處編輯)`,
            readingFile: ({ file }: { file: string }) => `正在讀取 ${file}`,
            writingFile: ({ file }: { file: string }) => `正在寫入 ${file}`,
            modifyingFile: ({ file }: { file: string }) => `正在修改 ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `正在修改 ${count} 個檔案`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} 和其他 ${count} 個`,
            showingDiff: '顯示更改',
        }
    },

    files: {
        changes: '變更',
        searchPlaceholder: '搜尋檔案...',
        detachedHead: '游離 HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} 已暫存 • ${unstaged} 未暫存`,
        notRepo: '不是 git 倉庫',
        notUnderGit: '此目錄不在 git 版本控制下',
        searching: '正在搜尋檔案...',
        noFilesFound: '未找到檔案',
        noFilesInProject: '專案中沒有檔案',
        tryDifferentTerm: '嘗試不同的搜尋詞',
        searchResults: ({ count }: { count: number }) => `搜尋結果 (${count})`,
        projectRoot: '專案根目錄',
        stagedChanges: ({ count }: { count: number }) => `已暫存的更改 (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `未暫存的更改 (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `正在載入 ${fileName}...`,
        binaryFile: '二進位檔案',
        cannotDisplayBinary: '無法顯示二進位檔案內容',
        diff: '差異',
        file: '檔案',
        fileEmpty: '檔案為空',
        noChanges: '沒有要顯示的更改',
        noChangesTitle: '沒有變更',
        noChangesSubtitle: '工作區是乾淨的',
        deleted: '已刪除',
        changedFiles: ({ count }: { count: number }) => `${count} 個已變更的檔案`,
        allFiles: '所有檔案',
        addPanel: '新增面板',
        closePanel: '關閉面板',
        editFile: '編輯',
        saveFile: '儲存',
        failedToRead: '讀取檔案失敗',
        failedToSave: '儲存檔案失敗',
        fileConflict: '檔案衝突',
        fileConflictDescription: '編輯期間檔案已在裝置上被修改。重新載入以查看最新版本。',
        reload: '重新載入',
        overwrite: '覆蓋',
    },
    sideChat: {
        panelTitle: '側邊聊天',
        emptyTitle: '開始側邊聊天',
        emptySubtitle: '在一旁向智能體提問。它會繼承此聊天的上下文，但保持獨立——這裡的任何操作都不會影響主對話。',
        startButton: '開始側邊聊天',
        creating: '正在開始側邊聊天…',
        unavailable: '此工作階段暫時無法開始側邊聊天——請等待智能體上線。',
        composerPlaceholder: '傳送訊息到側邊聊天…',
        expand: '全螢幕開啟',
        tabLabel: ({ index }: { index: number }) => `側邊聊天 ${index}`,
        newChat: '新增側邊聊天',
        close: '關閉側邊聊天',
    },



    settingsLanguage: {
        // Language settings screen
        title: '語言',
        description: '選擇您希望應用程式介面使用的語言。此設定將在您的所有裝置間同步。',
        currentLanguage: '目前語言',
        automatic: '自動',
        automaticSubtitle: '從裝置設定中偵測',
        needsRestart: '語言已更改',
        needsRestartMessage: '應用程式需要重新啟動以套用新的語言設定。',
        restartNow: '立即重新啟動',
    },


    updateBanner: {
        updateAvailable: '有可用更新',
        pressToApply: '點擊套用更新',
        whatsNew: "更新內容",
        seeLatest: '查看最新更新和改進',
        nativeUpdateAvailable: '應用程式更新可用',
        tapToUpdateAppStore: '點擊在 App Store 中更新',
        tapToUpdatePlayStore: '點擊在 Play Store 中更新',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `版本 ${version}`,
        noEntriesAvailable: '沒有可用的更新日誌條目。',
    },


    modals: {
        // Used across connect flows and settings
        authenticateTerminal: '驗證終端',
        pasteUrlFromTerminal: '貼上來自您終端的驗證 URL',
        deviceLinkedSuccessfully: '裝置連結成功',
        terminalConnectedSuccessfully: '終端連線成功',
        invalidAuthUrl: '無效的驗證 URL',
        failedToConnectTerminal: '連線終端失敗',
        cameraPermissionsRequiredToConnectTerminal: '連線終端需要相機權限',
        failedToLinkDevice: '連結裝置失敗',
        cameraPermissionsRequiredToScanQr: '掃描 QR Code 需要相機權限'
    },

    navigation: {
        // Navigation titles and screen headers
        whatsNew: "更新日誌",
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Codex 和 Claude Code 行動用戶端',
        subtitle: '端對端加密，您的帳戶僅儲存在您的裝置上。',
        createAccount: '建立帳戶',
        linkOrRestoreAccount: '連結或恢復帳戶',
        loginWithMobileApp: '使用行動應用程式登入',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: '喜歡這個應用程式嗎？',
        feedbackPrompt: "我們很希望聽到您的回饋！",
        yesILoveIt: '是的，我喜歡！',
        notReally: '不太喜歡'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} 已複製到剪貼簿`
    },

    machine: {
        launchNewSessionInDirectory: '在目錄中啟動新工作階段',
        offlineUnableToSpawn: '裝置離線時無法啟動',
        offlineHelp: '• 確保您的電腦在線上\n• 執行 `happy daemon status` 進行診斷\n• 您是否在執行最新的 CLI 版本？請使用 `npm install -g happy@latest` 升級',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `已切換到 ${mode} 模式`,
        unknownEvent: '未知事件',
        usageLimitUntil: ({ time }: { time: string }) => `使用限制到 ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: '未知時間',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: '是，並且本次工作階段不再詢問',
            stopAndExplain: '停止，並說明該做什麼',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: '是，允許本次工作階段的所有編輯',
            yesAllowEverything: '是，允許本次工作階段的所有操作',
            yesForTool: '是，不再詢問此工具',
            noTellClaude: '否，並告訴 Claude 該如何不同地操作',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: '選擇文字範圍',
        title: '選擇文字',
        noTextProvided: '未提供文字',
        textNotFound: '文字未找到或已過期',
        textCopied: '文字已複製到剪貼簿',
        failedToCopy: '複製文字到剪貼簿失敗',
        noTextToCopy: '沒有可複製的文字',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: '程式碼已複製',
        copyFailed: '複製失敗',
        mermaidRenderFailed: '渲染 mermaid 圖表失敗',
    },




    imageUpload: {
        permissionTitle: '存取照片圖庫',
        permissionMessage: '允許存取您的照片圖庫以在訊息中附加圖片。',
        limitTitle: '已達到圖片限制',
        limitMessage: ({ max }: { max: number }) => `每則訊息最多可附加 ${max} 張圖片。`,
        fileTooLargeTitle: '檔案太大',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}"超過了 ${maxMb}MB 的限制，未能新增。`,
        uploadFailedTitle: '上傳失敗',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? '一張圖片上傳失敗，未傳送。'
            : `${count} 張圖片上傳失敗，未傳送。`,
        notSupportedTitle: '不支援圖片',
        notSupportedMessage: '此代理不支援圖片附件。圖片未傳送。',
    },

} as const;
