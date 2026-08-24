/**
 * Japanese translations for the Happy app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

import { TranslationStructure } from "../_default";

/**
 * Japanese plural helper function
 * Japanese doesn't have grammatical plurals, so this just returns the appropriate form
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on count
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

export const ja: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'ターミナル',
        settings: '設定',
    },


    common: {
        // Simple string constants
        cancel: 'キャンセル',
        authenticate: '認証',
        save: '保存',
        error: 'エラー',
        success: '成功',
        ok: 'OK',
        continue: '続行',
        back: '戻る',
        create: '作成',
        rename: '名前を変更',
        reset: 'リセット',
        logout: 'ログアウト',
        yes: 'はい',
        no: 'いいえ',
        discard: '破棄',
        version: 'バージョン',
        copied: 'コピーしました',
        copy: 'コピー',
        scanning: 'スキャン中...',
        urlPlaceholder: 'https://example.com',
        home: 'ホーム',
        message: 'メッセージ',
        files: 'ファイル',
        fileViewer: 'ファイルビューアー',
        loading: '読み込み中...',
        retry: '再試行',
        delete: '削除',
        optional: '任意',
        saveAs: '名前を付けて保存',
    },

    profile: {
        userProfile: 'ユーザープロフィール',
        details: '詳細',
        firstName: '名',
        lastName: '姓',
        username: 'ユーザー名',
        status: 'ステータス',
    },

    status: {
        connected: '接続済み',
        connecting: '接続中',
        disconnected: '切断済み',
        error: 'エラー',
        online: 'オンライン',
        offline: 'オフライン',
        lastSeen: ({ time }: { time: string }) => `最終アクセス: ${time}`,
        permissionRequired: '権限が必要です',
        activeNow: 'アクティブ',
        unknown: '不明',
        unread: '新しい結果',
    },

    time: {
        justNow: 'たった今',
        minutesAgo: ({ count }: { count: number }) => `${count}分前`,
        hoursAgo: ({ count }: { count: number }) => `${count}時間前`,
        daysAgo: ({ count }: { count: number }) => `${count}日前`,
    },

    connect: {
        enterUrlManually: 'URLを手動で入力',
    },

    settings: {
        title: '設定',
        github: 'GitHub',
        features: '機能',
        appearance: '外観',
        appearanceSubtitle: 'アプリの見た目をカスタマイズ',
        featuresTitle: '機能',
        featuresSubtitle: 'アプリ機能の有効/無効を切り替え',
        about: 'このアプリについて',
        aboutFooter: 'Happy CoderはCodexとClaude Codeのモバイルクライアントです。完全なエンドツーエンド暗号化を採用し、アカウントはデバイスにのみ保存されます。Anthropicとは提携していません。',
        whatsNew: '新機能',
        whatsNewSubtitle: '最新のアップデートと改善を確認',
        reportIssue: '問題を報告',
        privacyPolicy: 'プライバシーポリシー',
        termsOfService: '利用規約',
        eula: 'EULA',
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature}を${enabled ? '有効' : '無効'}にしました`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'テーマ',
        themeDescription: 'お好みの配色を選択',
        themeOptions: {
            adaptive: '自動',
            light: 'ライト',
            dark: 'ダーク',
        },
        themeDescriptions: {
            adaptive: 'システム設定に合わせる',
            light: '常にライトテーマを使用',
            dark: '常にダークテーマを使用',
        },
        chat: 'チャット',
        chatDescription: 'チャットメッセージの見た目をカスタマイズ',
        sessionStatusBar: 'セッションステータス情報',
        sessionStatusBarDescription: 'ブランチ、モデル、エフォート、コンテキストの表示場所を選択',
        sessionStatusDisplayOptions: {
            hidden: '非表示',
            above: '入力欄の上',
            below: '入力欄の下',
        },
        usageLimitShowRemaining: '残量を表示',
        usageLimitShowRemainingDescription: '上限を使用量ではなく残量で表示します',
        userMessageBubbleColor: 'ユーザーバブルの色',
        userMessageBubbleColorDescription: '長いチャットで自分のメッセージを見つけやすくします',
        userMessageBubbleColorOptions: {
            blue: 'ブルー',
            green: 'グリーン',
            purple: 'パープル',
            rose: 'ローズ',
            sand: 'サンド',
            gray: 'グレー',
        },
        display: '表示',
        displayDescription: 'レイアウトと間隔を調整',
        compactToolCalls: 'ツール呼び出しをコンパクト表示',
        compactToolCallsDescription: '非対話型のツール呼び出しを1行で表示し、行を開いて詳細を確認します',
        inlineToolCalls: 'ツール呼び出しをインライン表示',
        inlineToolCallsDescription: 'チャットメッセージ内にツール呼び出しを直接表示',
        expandTodoLists: 'Todoリストを展開',
        expandTodoListsDescription: '変更点だけでなくすべてのTodoを表示',
        showLineNumbersInDiffs: '差分に行番号を表示',
        showLineNumbersInDiffsDescription: 'コード差分に行番号を表示',
        showLineNumbersInToolViews: 'ツールビューに行番号を表示',
        showLineNumbersInToolViewsDescription: 'ツールビューの差分に行番号を表示',
        wrapLinesInDiffs: '差分で行を折り返し',
        wrapLinesInDiffsDescription: '差分表示で水平スクロールの代わりに長い行を折り返す',
        diffStyle: '差分表示',
        diffStyleDescription: '差分を1列（unified）または横並び（split）で表示します。split 表示は Web 専用です。',
        diffStyleOptions: {
            unified: 'Unified',
            split: 'Split',
        },
        alwaysShowContextSize: '常にコンテキストサイズを表示',
        alwaysShowContextSizeDescription: '上限に近づいていなくてもコンテキスト使用量を表示',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: '実験的機能',
        experimentsDescription: '開発中の実験的機能を有効にします。これらの機能は不安定であったり、予告なく変更される場合があります。',
        experimentalFeatures: '実験的機能',
        experimentalFeaturesEnabled: '実験的機能が有効です',
        experimentalFeaturesDisabled: '安定版機能のみを使用',
        webFeatures: 'Web機能',
        webFeaturesDescription: 'Webバージョンでのみ利用可能な機能。',
        enterToSend: 'Enterで送信',
        enterToSendEnabled: 'Enterで送信（Shift+Enterで改行）',
        enterToSendDisabled: 'Enterで改行',
        commandPalette: 'コマンドパレット',
        commandPaletteEnabled: '⌘Kで開く',
        commandPaletteDisabled: 'クイックコマンドアクセスは無効',
        markdownCopyV2: 'Markdownコピー v2',
        markdownCopyV2Subtitle: '長押しでコピーモーダルを開く',
        hideInactiveSessions: '非アクティブセッションを非表示',
        hideInactiveSessionsSubtitle: 'アクティブなチャットのみをリストに表示',
        groupToolCalls: 'ツール呼び出しをグループ化',
        groupToolCallsSubtitle: '連続するツール呼び出しを1つのコンテナにまとめる',
        privacy: 'プライバシー',
        privacyDescription: 'すべての分析とテレメトリを完全に無効にします。PostHogやその他のトラッキングサービスにデータは送信されません。',
        disableAnalytics: '分析を無効化',
        analyticsDisabled: 'すべてのトラッキングとテレメトリが無効',
        analyticsEnabled: '匿名の使用状況分析がアクティブ',
        imageUpload: '画像アップロード',
        imageUploadSubtitle: '対応エージェントに分析させるため、メッセージに画像を添付する',
    },

    errors: {
        networkError: 'ネットワークエラーが発生しました',
        serverError: 'サーバーエラーが発生しました',
        unknownError: '不明なエラーが発生しました',
        connectionTimeout: '接続がタイムアウトしました',
        authenticationFailed: '認証に失敗しました',
        permissionDenied: '権限がありません',
        fileNotFound: 'ファイルが見つかりません',
        invalidFormat: 'フォーマットが無効です',
        operationFailed: '操作に失敗しました',
        tryAgain: '再試行してください',
        contactSupport: '問題が続く場合はサポートにお問い合わせください',
        sessionNotFound: 'セッションが見つかりません',
        voiceSessionFailed: '音声セッションの開始に失敗しました',
        voiceServiceUnavailable: '音声サービスは一時的に利用できません',
        voiceLimitReachedTitle: '音声の上限に達しました',
        voiceHardLimitReached: ({ hours }: { hours: number }) => `今月${hours}時間以上の音声を使用しました。これは許可される最大量です。音声設定で独自の ElevenLabs エージェントを設定して、自分のクォータを使用できます。`,
        voiceConversationLimitReached: '今月の音声会話の最大数に達しました。将来的にオンデマンドの音声利用を追加する可能性があります。この制限に達した場合は、github.com/nicepkg/happy/issues で issue を作成してください。',
        oauthInitializationFailed: 'OAuth フローの初期化に失敗しました',
        tokenStorageFailed: '認証トークンの保存に失敗しました',
        oauthStateMismatch: 'セキュリティ検証に失敗しました。再試行してください',
        tokenExchangeFailed: '認可コードの交換に失敗しました',
        oauthAuthorizationDenied: '認可が拒否されました',
        webViewLoadFailed: '認証ページの読み込みに失敗しました',
        failedToLoadProfile: 'ユーザープロフィールの読み込みに失敗しました',
        userNotFound: 'ユーザーが見つかりません',
        sessionDeleted: 'セッションは削除されました',
        sessionDeletedDescription: 'このセッションは完全に削除されました',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field}は${min}から${max}の間である必要があります`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `${seconds}秒後に再試行`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (エラー ${code})`,
    },

    newSession: {
        title: '新しいセッションを開始',
        machineOffline: 'マシンがオフラインです',
        switchMachinesHint: '• 上のマシンをクリックしてマシンを切り替えてください',
    },

    sessionHistory: {
        // Used by session history screen
        empty: 'セッションが見つかりません',
        daysAgo: ({ count }: { count: number }) => `${count}日前`,
    },

    session: {
        inputPlaceholder: 'メッセージを入力...',
        inactiveArchived: 'このセッションは非アクティブです。',
        resumeFromTerminal: 'ターミナルから再開するには:',
        newChat: '新規チャット',
        statusBarContext: 'コンテキスト',
        statusBarPathTitle: '作業ディレクトリ',
        forkAction: 'セッションをフォーク',
        forkSubtitle: '同じコンテキストで新しいセッションを続行',
        duplicateAction: 'メッセージから複製…',
        duplicateSubtitle: '選んだ地点まで巻き戻してやり直す',
        forkFromHere: 'ここからフォーク',
        duplicateSheetTitle: '巻き戻しポイントを選択',
        duplicateSheetSubtitle: '新しいセッションは選んだターン全体（あなたのメッセージとエージェントの応答）を保持し、それ以降のメッセージは破棄します。',
        duplicateSheetConfirm: '複製',
        duplicateSheetEmpty: 'このセッションには巻き戻し可能なメッセージがまだありません。',
        duplicateRowDisabled: 'このメッセージは巻き戻しポイントに使えません。',
        forkedFromLabel: 'フォーク元',
        forkedFromSubtitle: 'フォーク元のセッションを開く',
        forkErrorOffline: 'マシンがオフラインです。セッションのマシンがオンラインの間のみフォークできます。',
        forkErrorMissingUuid: '選んだ巻き戻しポイントがソースセッションに存在しません — 切り詰めなしのフォークをお試しください。',
        forkErrorMissingMetadata: 'フォークに必要なセッションのメタデータがありません。',
        forkErrorGeneric: 'セッションのフォークに失敗しました。',
        forkClaudeOnly: 'フォークは現在 Claude セッションのみ対応しています。',
    },

    commandPalette: {
        placeholder: 'コマンドを入力または検索...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'セッションを終了',
        killSessionConfirm: 'このセッションを終了してもよろしいですか？',
        archiveSession: 'セッションをアーカイブ',
        archiveSessionConfirm: 'このセッションをアーカイブしてもよろしいですか？',
        happySessionIdCopied: 'Happy Session IDがクリップボードにコピーされました',
        failedToCopySessionId: 'Happy Session IDのコピーに失敗しました',
        happySessionId: 'Happy Session ID',
        claudeCodeSessionId: 'Claude Code Session ID',
        claudeCodeSessionIdCopied: 'Claude Code Session IDがクリップボードにコピーされました',
        codexThreadId: 'Codex Thread ID',
        codexThreadIdCopied: 'Codex Thread IDがクリップボードにコピーされました',
        aiProvider: 'AIプロバイダー',
        failedToCopyClaudeCodeSessionId: 'Claude Code Session IDのコピーに失敗しました',
        failedToCopyCodexThreadId: 'Codex Thread IDのコピーに失敗しました',
        metadataCopied: 'メタデータがクリップボードにコピーされました',
        failedToCopyMetadata: 'メタデータのコピーに失敗しました',
        failedToKillSession: 'セッションの終了に失敗しました',
        failedToArchiveSession: 'セッションのアーカイブに失敗しました',
        connectionStatus: '接続状態',
        created: '作成日時',
        lastUpdated: '最終更新',
        sequence: 'シーケンス',
        quickActions: 'クイックアクション',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionNeedsHappyAgent: 'Resume is unavailable on this machine. Run `happy-agent auth login` to enable it.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Claude or Codex identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        killSessionSubtitle: 'セッションを即座に終了',
        archiveSessionSubtitle: 'このセッションをアーカイブして停止',
        metadata: 'メタデータ',
        host: 'ホスト',
        path: 'パス',
        operatingSystem: 'オペレーティングシステム',
        processId: 'プロセスID',
        happyHome: 'Happy Home',
        copyMetadata: 'メタデータをコピー',
        agentState: 'エージェント状態',
        controlledByUser: 'ユーザーによる制御',
        pendingRequests: '保留中のリクエスト',
        activity: 'アクティビティ',
        thinking: '思考中',
        thinkingSince: '思考開始時刻',
        cliVersion: 'CLIバージョン',
        cliVersionOutdated: 'CLIの更新が必要',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `バージョン ${currentVersion} がインストールされています。${requiredVersion} 以降に更新してください`,
        updateCliInstructions: 'npm install -g happy@latest を実行してください',
        deleteSession: 'セッションを削除',
        deleteSessionSubtitle: 'このセッションを完全に削除',
        deleteSessionConfirm: 'セッションを完全に削除しますか？',
        deleteSessionWarning: 'この操作は取り消せません。このセッションに関連するすべてのメッセージとデータが完全に削除されます。',
        failedToDeleteSession: 'セッションの削除に失敗しました',
        sessionDeleted: 'セッションが正常に削除されました',
        worktreeCleanupTitle: 'Worktreeを削除しますか？',
        worktreeCleanupMessage: 'Worktreeにコミットされていない変更はありません。Worktreeのファイルを削除しますか？',
        worktreeCleanupDelete: 'Worktreeを削除',
        worktreeCleanupKeep: 'ファイルを保持',

    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'コーディングを始めますか？',
            installCli: 'Happy CLIをインストール',
            runIt: '実行する',
            scanQrCode: 'QRコードをスキャン',
            openCamera: 'カメラを開く',
        },
        agentGoalBar: {
            currentGoal: '現在の目標',
            accessibilityLabel: ({ goal }: { goal: string }) => `現在の目標: ${goal}`,
            clearGoal: '目標をクリア',
            stopGoal: '目標を停止',
            editGoal: '目標を編集',
        },
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `コンテキスト ${total}トークン中${used}、${percent}%`,
            limitFiveHour: '5時間の上限',
            limitSevenDay: '7日間の上限',
            limitResets: ({ time }: { time: string }) => `${time} リセット`,
            limitAsOf: ({ age }: { age: string }) => `${age}前のデータ`,
            limitRemaining: ({ percent }: { percent: number }) => `残り ${percent}%`,
        },
    },

    agentInput: {
        permissionMode: {
            title: '権限モード',
            default: 'デフォルト',
            acceptEdits: '編集を許可',
            plan: 'プランモード',
            dontAsk: '確認しない',
            bypassPermissions: 'Yoloモード',
            badgeAcceptAllEdits: 'すべての編集を許可',
            badgeBypassAllPermissions: 'すべての権限をバイパス',
            badgePlanMode: 'プランモード',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
            openclaw: 'OpenClaw',
        },
        model: {
            title: 'モデル',
            configureInCli: 'CLIの設定でモデルを構成',
        },
        effort: {
            title: 'エフォート',
        },
        codexPermissionMode: {
            title: 'CODEX権限モード',
            default: 'CLI設定',
            readOnly: '読み取り専用モード',
            safeYolo: 'セーフYOLO',
            yolo: 'YOLO',
            defaultDescription: '信頼されていないコマンドの前に確認',
            readOnlyDescription: '書き込みなし',
            safeYoloDescription: '確認なし、ワークスペースサンドボックス',
            yoloDescription: '確認なし、フルアクセス',
            badgeReadOnly: '読み取り専用モード',
            badgeSafeYolo: 'セーフYOLO',
            badgeYolo: 'YOLO',
        },
        codexModel: {
            title: 'CODEXモデル',
            gpt5CodexLow: 'gpt-5-codex 低',
            gpt5CodexMedium: 'gpt-5-codex 中',
            gpt5CodexHigh: 'gpt-5-codex 高',
            gpt5Minimal: 'GPT-5 最小',
            gpt5Low: 'GPT-5 低',
            gpt5Medium: 'GPT-5 中',
            gpt5High: 'GPT-5 高',
        },
        geminiPermissionMode: {
            title: 'GEMINI権限モード',
            default: 'デフォルト',
            autoEdit: '自動編集',
            yolo: 'YOLO',
            plan: 'プラン',
            badgeAutoEdit: '自動編集',
            badgeYolo: 'YOLO',
            badgePlan: 'プラン',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `残り ${percent}%`,
        },
        suggestion: {
            fileLabel: 'ファイル',
            folderLabel: 'フォルダ',
        },
        noMachinesAvailable: 'マシンなし',
    },

    machineLauncher: {
        showLess: '折りたたむ',
        showAll: ({ count }: { count: number }) => `すべて表示 (${count}パス)`,
        enterCustomPath: 'カスタムパスを入力',
        offlineUnableToSpawn: 'オフラインのため新しいセッションを生成できません',
    },

    agentQuestion: {
        title: "質問",
        submit: "回答を送信",
        chooseMultiple: "当てはまるものをすべて選択",
        ownAnswer: "自分で回答",
        ownAnswerPlaceholder: "回答を入力",
        submitFailed: "回答を送信できませんでした",
        dismiss: "閉じる",
        unsupportedTitle: "未対応のリクエスト",
        unsupportedDescription: ({ kind }: { kind: string }) => `このバージョンの Happy は「${kind}」リクエストを表示できません。アプリを更新してください。`,
        moreQuestions: ({ count }: { count: number }) =>
            count === 1 ? "他に1件の質問" : `${count} 件の質問`,
    },

    sidebar: {
        sessionsTitle: 'Happy',
        showArchived: 'アーカイブを表示',
        hideArchived: 'アーカイブを非表示',
        newSession: '新しいセッション',
        projects: "プロジェクト",
    },

    zen: {
        toggle: 'Zenモード',
    },

    toolView: {
        input: '入力',
        output: '出力',
    },

    toolGroup: {
        editedFile: 'Edited file',
        editedFiles: ({ count }: { count: number }) => `${count}個のファイルを編集`,
        readFiles: ({ count }: { count: number }) => `${count}個のファイルを読み取り`,
        ranCommands: ({ count }: { count: number }) => `${count}個のコマンドを実行`,
        searched: ({ count }: { count: number }) => `${count}回検索`,
        fetchedUrls: ({ count }: { count: number }) => `${count}個のURLを取得`,
        ranTasks: ({ count }: { count: number }) => `${count}個のタスクを実行`,
        usedTools: ({ count }: { count: number }) => `${count}個のツールを使用`,
        workedFor: ({ duration }: { duration: string }) => `Worked ${duration}`,
    },

    tools: {
        fullView: {
            description: '説明',
            inputParams: '入力パラメータ',
            output: '出力',
            error: 'エラー',
            completed: 'ツールが正常に完了しました',
            noOutput: '出力がありません',
            running: 'ツールを実行中...',
            rawJsonDevMode: 'Raw JSON (開発モード)',
        },
        taskView: {
            initializing: 'エージェントを初期化中...',
            moreTools: ({ count }: { count: number }) => `+${count} 個のツール`,
        },
        askUserQuestion: {
            submit: '回答を送信',
            multipleQuestions: ({ count }: { count: number }) => `${count}件の質問`,
            other: 'その他',
            otherDescription: '自分の回答を入力',
            otherPlaceholder: '回答を入力...',
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `編集 ${index}/${total}`,
            replaceAll: 'すべて置換',
        },
        names: {
            task: 'タスク',
            terminal: 'ターミナル',
            searchFiles: 'ファイル検索',
            search: '検索',
            searchContent: 'コンテンツ検索',
            listFiles: 'ファイル一覧',
            planProposal: 'プラン提案',
            readFile: 'ファイル読み取り',
            editFile: 'ファイル編集',
            writeFile: 'ファイル書き込み',
            fetchUrl: 'URL取得',
            readNotebook: 'ノートブック読み取り',
            editNotebook: 'ノートブック編集',
            todoList: 'Todoリスト',
            webSearch: 'Web検索',
            reasoning: '推論',
            applyChanges: 'ファイルを更新',
            viewDiff: '現在のファイル変更',
            question: '質問',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `ターミナル(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `検索(pattern: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `検索(path: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `URL取得(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `ノートブック編集(file: ${path}, mode: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Todoリスト(count: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Web検索(query: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(pattern: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count}件の編集)`,
            readingFile: ({ file }: { file: string }) => `${file}を読み取り中`,
            writingFile: ({ file }: { file: string }) => `${file}に書き込み中`,
            modifyingFile: ({ file }: { file: string }) => `${file}を変更中`,
            modifyingFiles: ({ count }: { count: number }) => `${count}ファイルを変更中`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} 他${count}件`,
            showingDiff: '変更を表示中',
        }
    },

    files: {
        changes: '変更',
        searchPlaceholder: 'ファイルを検索...',
        detachedHead: 'detached HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `ステージ済み ${staged} • 未ステージ ${unstaged}`,
        notRepo: 'Gitリポジトリではありません',
        notUnderGit: 'このディレクトリはGitバージョン管理下にありません',
        searching: 'ファイルを検索中...',
        noFilesFound: 'ファイルが見つかりません',
        noFilesInProject: 'プロジェクトにファイルがありません',
        tryDifferentTerm: '別の検索語を試してください',
        searchResults: ({ count }: { count: number }) => `検索結果 (${count})`,
        projectRoot: 'プロジェクトルート',
        stagedChanges: ({ count }: { count: number }) => `ステージ済みの変更 (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `未ステージの変更 (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `${fileName}を読み込み中...`,
        binaryFile: 'バイナリファイル',
        cannotDisplayBinary: 'バイナリファイルの内容を表示できません',
        diff: '差分',
        file: 'ファイル',
        fileEmpty: 'ファイルは空です',
        noChanges: '表示する変更はありません',
        noChangesTitle: '変更なし',
        noChangesSubtitle: 'ワーキングツリーはクリーンです',
        deleted: '削除済み',
        changedFiles: ({ count }: { count: number }) => `${count}件の変更ファイル`,
        allFiles: 'すべてのファイル',
        addPanel: 'パネルを追加',
        closePanel: 'パネルを閉じる',
        editFile: '編集',
        saveFile: '保存',
        failedToRead: 'ファイルの読み取りに失敗しました',
        failedToSave: 'ファイルの保存に失敗しました',
        fileConflict: 'ファイルの競合',
        fileConflictDescription: '編集中にデバイス上でファイルが変更されました。最新版を表示するには再読み込みしてください。',
        reload: '再読み込み',
        overwrite: '上書き',
    },
    sideChat: {
        panelTitle: 'サイドチャット',
        emptyTitle: 'サイドチャットを始める',
        emptySubtitle: 'エージェントに脇で質問しましょう。このチャットのコンテキストを引き継ぎますが独立しており — ここでの操作はメインの会話に影響しません。',
        startButton: 'サイドチャットを開始',
        creating: 'サイドチャットを開始しています…',
        unavailable: 'このセッションではまだサイドチャットを開始できません — エージェントがオンラインになるまでお待ちください。',
        composerPlaceholder: 'サイドチャットにメッセージ…',
        expand: '全画面で開く',
        tabLabel: ({ index }: { index: number }) => `サイドチャット ${index}`,
        newChat: '新しいサイドチャット',
        close: 'サイドチャットを閉じる',
    },



    settingsLanguage: {
        // Language settings screen
        title: '言語',
        description: 'アプリインターフェースの言語を選択します。この設定はすべてのデバイスで同期されます。',
        currentLanguage: '現在の言語',
        automatic: '自動',
        automaticSubtitle: 'デバイス設定から検出',
        needsRestart: '言語が変更されました',
        needsRestartMessage: '新しい言語設定を適用するにはアプリの再起動が必要です。',
        restartNow: '今すぐ再起動',
    },


    updateBanner: {
        updateAvailable: 'アップデートが利用可能',
        pressToApply: 'タップしてアップデートを適用',
        whatsNew: "新機能",
        seeLatest: '最新のアップデートと改善を確認',
        nativeUpdateAvailable: 'アプリのアップデートが利用可能',
        tapToUpdateAppStore: 'タップしてApp Storeで更新',
        tapToUpdatePlayStore: 'タップしてPlay Storeで更新',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `バージョン ${version}`,
        noEntriesAvailable: '変更履歴はありません。',
    },


    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'ターミナルを認証',
        pasteUrlFromTerminal: 'ターミナルから認証URLを貼り付けてください',
        deviceLinkedSuccessfully: 'デバイスが正常にリンクされました',
        terminalConnectedSuccessfully: 'ターミナルが正常に接続されました',
        invalidAuthUrl: '無効な認証URL',
        failedToConnectTerminal: 'ターミナルの接続に失敗しました',
        cameraPermissionsRequiredToConnectTerminal: 'ターミナルの接続にはカメラの権限が必要です',
        failedToLinkDevice: 'デバイスのリンクに失敗しました',
        cameraPermissionsRequiredToScanQr: 'QRコードのスキャンにはカメラの権限が必要です'
    },

    navigation: {
        // Navigation titles and screen headers
        whatsNew: "新機能",
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'CodexとClaude Codeのモバイルクライアント',
        subtitle: 'エンドツーエンド暗号化され、アカウントはデバイスにのみ保存されます。',
        createAccount: 'アカウントを作成',
        linkOrRestoreAccount: 'アカウントをリンクまたは復元',
        loginWithMobileApp: 'モバイルアプリでログイン',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'アプリを気に入っていただけましたか？',
        feedbackPrompt: "ご意見をお聞かせください！",
        yesILoveIt: 'はい、気に入りました！',
        notReally: 'あまり...'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label}がクリップボードにコピーされました`
    },

    machine: {
        launchNewSessionInDirectory: 'ディレクトリで新しいセッションを起動',
        offlineUnableToSpawn: 'マシンがオフラインのためランチャーは無効です',
        offlineHelp: '• コンピューターがオンラインであることを確認してください\n• `happy daemon status`を実行して診断してください\n• 最新のCLIバージョンを使用していますか？`npm install -g happy@latest`でアップグレードしてください',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `${mode}モードに切り替えました`,
        unknownEvent: '不明なイベント',
        usageLimitUntil: ({ time }: { time: string }) => `${time}まで使用制限中`,
        sentAsGoal: 'Sent as goal',
        unknownTime: '不明な時間',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: "はい、このセッションでは確認しない",
            stopAndExplain: '停止して、何をすべきか説明',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'はい、このセッション中のすべての編集を許可',
            yesAllowEverything: 'はい、このセッション中のすべてを許可',
            yesForTool: "はい、このツールについては確認しない",
            noTellClaude: 'いいえ、フィードバックを提供',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: 'テキスト範囲を選択',
        title: 'テキストを選択',
        noTextProvided: 'テキストが提供されていません',
        textNotFound: 'テキストが見つからないか期限切れです',
        textCopied: 'テキストがクリップボードにコピーされました',
        failedToCopy: 'テキストのクリップボードへのコピーに失敗しました',
        noTextToCopy: 'コピーできるテキストがありません',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'コードをコピーしました',
        copyFailed: 'コピーに失敗しました',
        mermaidRenderFailed: 'Mermaidダイアグラムのレンダリングに失敗しました',
    },




    beelineIdentity: {
        handleCeremonyLabel: 'ID · ハンドル設定',
        handleInvalidTitle: 'ハンドルを使用できません',
        handleInvalidMessage: '3～30文字の小文字、数字、ハイフンを使用してください。',
        handleTakenTitle: 'ハンドルは使用済みです',
        handleClaimFailedTitle: 'ハンドルを取得できませんでした',
        handleTakenMessage: ({ handle }: { handle: string }) => `@${handle} は他のユーザーが使用しています。別のハンドルを選んでください。`,
        handleCeremonyTitle: 'ハンドルを選択',
        handleCeremonyBody: 'この名前は鍵に結び付けられ、どこでも認証済みの Beeline ID になります。',
        handleAccessibility: 'Beeline ハンドルを選択',
        handlePlaceholder: 'ada-labs',
        handleRules: '3–30 · a–z · 0–9 · ハイフン',
        claimHandle: 'ハンドルを取得',
        githubLinkedNotice: 'GitHub をこの鍵に連携しました。ID と履歴はそのまま維持されています。',
        githubRenameNotice: ({ handle }: { handle: string }) => `認証済みハンドルは @${handle} になりました。`,
        claimStatusInvalid: '3-30文字の小文字、数字、ハイフンを使用',
        hostedHandleClaimBody: 'usebeeline.app で認証済みハンドルを先着順で取得します。',
        linkGithub: 'GitHub をこの鍵に連携',
        renameOffer: ({ current, github }: { current: string; github: string }) => `@${current} を維持するか、GitHub ハンドル @${github} に一度だけ変更できます。`,
        useGithubHandle: ({ handle }: { handle: string }) => `@${handle} を使用`,
    },

    imageUpload: {
        permissionTitle: 'フォトライブラリへのアクセス',
        permissionMessage: 'メッセージに画像を添付するには、フォトライブラリへのアクセスを許可してください。',
        limitTitle: '画像の上限に達しました',
        limitMessage: ({ max }: { max: number }) => `1メッセージに添付できる画像は最大${max}枚です。`,
        fileTooLargeTitle: 'ファイルが大きすぎます',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}"は${maxMb}MBの制限を超えているため追加されませんでした。`,
        uploadFailedTitle: 'アップロードに失敗しました',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? '1枚の画像をアップロードできず、送信されませんでした。'
            : `${count}枚の画像をアップロードできず、送信されませんでした。`,
        notSupportedTitle: '画像はサポートされていません',
        notSupportedMessage: 'このエージェントは画像の添付に対応していません。画像は送信されませんでした。',
    },

} as const;
