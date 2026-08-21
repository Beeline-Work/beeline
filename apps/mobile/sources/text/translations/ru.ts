import type { TranslationStructure } from '../_default';

/**
 * Russian plural helper function
 * Russian has 3 plural forms: one, few, many
 * @param options - Object containing count and the three plural forms
 * @returns The appropriate form based on Russian plural rules
 */
function plural({ count, one, few, many }: { count: number; one: string; few: string; many: string }): string {
    const n = Math.abs(count);
    const n10 = n % 10;
    const n100 = n % 100;
    
    // Rule: ends in 1 but not 11
    if (n10 === 1 && n100 !== 11) return one;
    
    // Rule: ends in 2-4 but not 12-14
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
    
    // Rule: everything else (0, 5-9, 11-19, etc.)
    return many;
}

/**
 * Russian translations for the Happy app
 * Must match the exact structure of the English translations
 */
export const ru: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Терминалы',
        settings: 'Настройки',
    },


    common: {
        // Simple string constants
        cancel: 'Отмена',
        authenticate: 'Авторизация',
        save: 'Сохранить',
        saveAs: 'Сохранить как',
        error: 'Ошибка',
        success: 'Успешно',
        ok: 'ОК',
        continue: 'Продолжить',
        back: 'Назад',
        create: 'Создать',
        rename: 'Переименовать',
        reset: 'Сбросить',
        logout: 'Выйти',
        yes: 'Да',
        no: 'Нет',
        discard: 'Отменить',
        version: 'Версия',
        copied: 'Скопировано',
        copy: 'Копировать',
        scanning: 'Сканирование...',
        urlPlaceholder: 'https://example.com',
        home: 'Главная',
        message: 'Сообщение',
        files: 'Файлы',
        fileViewer: 'Просмотр файла',
        loading: 'Загрузка...',
        retry: 'Повторить',
        delete: 'Удалить',
        optional: 'необязательно',
    },

    connect: {
        enterUrlManually: 'Ввести URL вручную',
    },

    settings: {
        title: 'Настройки',
        github: 'GitHub',
        features: 'Функции',
        appearance: 'Внешний вид',
        appearanceSubtitle: 'Настройка внешнего вида приложения',
        featuresTitle: 'Возможности',
        featuresSubtitle: 'Включить или отключить функции приложения',
        about: 'О программе',
        aboutFooter: 'Happy Coder — мобильное приложение для работы с Codex и Claude Code. Использует сквозное шифрование, все данные аккаунта хранятся только на вашем устройстве. Не связано с Anthropic.',
        whatsNew: 'Что нового',
        whatsNewSubtitle: 'Посмотреть последние обновления и улучшения',
        reportIssue: 'Сообщить о проблеме',
        privacyPolicy: 'Политика конфиденциальности',
        termsOfService: 'Условия использования',
        eula: 'EULA',
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'включена' : 'отключена'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Тема',
        themeDescription: 'Выберите предпочтительную цветовую схему',
        themeOptions: {
            adaptive: 'Адаптивная',
            light: 'Светлая', 
            dark: 'Тёмная',
        },
        themeDescriptions: {
            adaptive: 'Следовать настройкам системы',
            light: 'Всегда использовать светлую тему',
            dark: 'Всегда использовать тёмную тему',
        },
        chat: 'Чат',
        chatDescription: 'Настройте внешний вид сообщений в чате',
        sessionStatusBar: 'Информация о сессии',
        sessionStatusBarDescription: 'Выберите, где показывать ветку, модель, усилия и контекст',
        sessionStatusDisplayOptions: {
            hidden: 'Скрыто',
            above: 'Над полем ввода',
            below: 'Под полем ввода',
        },
        usageLimitShowRemaining: 'Показывать остаток',
        usageLimitShowRemainingDescription: 'Индикаторы лимита отсчитывают остаток, а не использование',
        userMessageBubbleColor: 'Цвет ваших сообщений',
        userMessageBubbleColorDescription: 'Сделайте ваши сообщения заметнее в длинных чатах',
        userMessageBubbleColorOptions: {
            blue: 'Синий',
            green: 'Зелёный',
            purple: 'Фиолетовый',
            rose: 'Розовый',
            sand: 'Песочный',
            gray: 'Серый',
        },
        display: 'Отображение',
        displayDescription: 'Управление макетом и интервалами',
        compactToolCalls: 'Компактные вызовы инструментов',
        compactToolCallsDescription: 'Показывать неинтерактивные вызовы одной строкой; нажмите строку для подробностей',
        inlineToolCalls: 'Встроенные вызовы инструментов',
        inlineToolCallsDescription: 'Отображать вызовы инструментов прямо в сообщениях чата',
        expandTodoLists: 'Развернуть списки задач',
        expandTodoListsDescription: 'Показывать все задачи вместо только изменений',
        showLineNumbersInDiffs: 'Показывать номера строк в различиях',
        showLineNumbersInDiffsDescription: 'Отображать номера строк в различиях кода',
        showLineNumbersInToolViews: 'Показывать номера строк в представлениях инструментов',
        showLineNumbersInToolViewsDescription: 'Отображать номера строк в различиях представлений инструментов',
        wrapLinesInDiffs: 'Перенос строк в различиях',
        wrapLinesInDiffsDescription: 'Переносить длинные строки вместо горизонтальной прокрутки в представлениях различий',
        diffStyle: 'Вид сравнения',
        diffStyleDescription: 'Показывать различия в одну колонку (unified) или рядом (split). Режим split доступен только на web.',
        diffStyleOptions: {
            unified: 'Unified',
            split: 'Split',
        },
        alwaysShowContextSize: 'Всегда показывать размер контекста',
        alwaysShowContextSizeDescription: 'Отображать использование контекста даже когда не близко к лимиту',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Эксперименты',
        experimentsDescription: 'Включить экспериментальные функции, которые всё ещё разрабатываются. Эти функции могут быть нестабильными или изменяться без предупреждения.',
        experimentalFeatures: 'Экспериментальные функции',
        experimentalFeaturesEnabled: 'Экспериментальные функции включены',
        experimentalFeaturesDisabled: 'Используются только стабильные функции',
        webFeatures: 'Веб-функции',
        webFeaturesDescription: 'Функции, доступные только в веб-версии приложения.',
        enterToSend: 'Enter для отправки',
        enterToSendEnabled: 'Нажмите Enter для отправки (Shift+Enter для новой строки)',
        enterToSendDisabled: 'Enter вставляет новую строку',
        commandPalette: 'Command Palette',
        commandPaletteEnabled: 'Нажмите ⌘K для открытия',
        commandPaletteDisabled: 'Быстрый доступ к командам отключён',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Долгое нажатие открывает модальное окно копирования',
        hideInactiveSessions: 'Скрывать неактивные сессии',
        hideInactiveSessionsSubtitle: 'Показывать в списке только активные чаты',
        groupToolCalls: 'Группировать вызовы инструментов',
        groupToolCallsSubtitle: 'Сворачивать подряд идущие вызовы инструментов в один блок',
        privacy: 'Конфиденциальность',
        privacyDescription: 'Полностью отключает всю аналитику и телеметрию. Никакие данные не будут отправляться в PostHog или другие сервисы отслеживания.',
        disableAnalytics: 'Отключить аналитику',
        analyticsDisabled: 'Вся аналитика и телеметрия отключены',
        analyticsEnabled: 'Анонимная аналитика использования активна',
        imageUpload: 'Загрузка изображений',
        imageUploadSubtitle: 'Прикрепляйте изображения к сообщениям для анализа поддерживаемыми агентами',
    },

    errors: {
        networkError: 'Произошла ошибка сети',
        serverError: 'Произошла ошибка сервера',
        unknownError: 'Произошла неизвестная ошибка',
        connectionTimeout: 'Время соединения истекло',
        authenticationFailed: 'Ошибка авторизации',
        permissionDenied: 'Доступ запрещен',
        fileNotFound: 'Файл не найден',
        invalidFormat: 'Неверный формат',
        operationFailed: 'Операция не выполнена',
        tryAgain: 'Пожалуйста, попробуйте снова',
        contactSupport: 'Если проблема сохранится, обратитесь в поддержку',
        sessionNotFound: 'Сессия не найдена',
        voiceSessionFailed: 'Не удалось запустить голосовую сессию',
        voiceServiceUnavailable: 'Голосовой сервис временно недоступен',
        voiceLimitReachedTitle: 'Лимит голоса достигнут',
        voiceHardLimitReached: ({ hours }: { hours: number }) => `Вы использовали ${hours}+ часов голосового общения в этом месяце. Это максимально допустимый лимит. Вы можете настроить собственного агента ElevenLabs в настройках голоса, чтобы использовать свою квоту.`,
        voiceConversationLimitReached: 'Вы достигли максимального количества голосовых разговоров в этом месяце. Возможно, в будущем мы добавим голосовое использование по запросу — пожалуйста, создайте заявку на github.com/nicepkg/happy/issues, если вы столкнулись с этим ограничением.',
        oauthInitializationFailed: 'Не удалось инициализировать процесс OAuth',
        tokenStorageFailed: 'Не удалось сохранить токены аутентификации',
        oauthStateMismatch: 'Ошибка проверки безопасности. Попробуйте снова',
        tokenExchangeFailed: 'Не удалось обменять код авторизации',
        oauthAuthorizationDenied: 'В авторизации отказано',
        webViewLoadFailed: 'Не удалось загрузить страницу аутентификации',
        failedToLoadProfile: 'Не удалось загрузить профиль пользователя',
        userNotFound: 'Пользователь не найден',
        sessionDeleted: 'Сессия была удалена',
        sessionDeletedDescription: 'Эта сессия была окончательно удалена',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} должно быть от ${min} до ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Повторить через ${seconds} ${plural({ count: seconds, one: 'секунду', few: 'секунды', many: 'секунд' })}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Ошибка ${code})`,
    },

    newSession: {
        title: 'Начать новую сессию',
        machineOffline: 'Машина недоступна',
        switchMachinesHint: '• Переключите машину, нажав на неё выше',
    },

    sessionHistory: {
        // Used by session history screen
        empty: 'Сессии не найдены',
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'день', few: 'дня', many: 'дней' })} назад`,
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Завершить сессию',
        killSessionConfirm: 'Вы уверены, что хотите завершить эту сессию?',
        archiveSession: 'Архивировать сессию',
        archiveSessionConfirm: 'Вы уверены, что хотите архивировать эту сессию?',
        happySessionIdCopied: 'ID сессии Happy скопирован в буфер обмена',
        failedToCopySessionId: 'Не удалось скопировать ID сессии Happy',
        happySessionId: 'ID сессии Happy',
        claudeCodeSessionId: 'ID сессии Claude Code',
        claudeCodeSessionIdCopied: 'ID сессии Claude Code скопирован в буфер обмена',
        codexThreadId: 'ID треда Codex',
        codexThreadIdCopied: 'ID треда Codex скопирован в буфер обмена',
        aiProvider: 'Поставщик ИИ',
        failedToCopyClaudeCodeSessionId: 'Не удалось скопировать ID сессии Claude Code',
        failedToCopyCodexThreadId: 'Не удалось скопировать ID треда Codex',
        metadataCopied: 'Метаданные скопированы в буфер обмена',
        failedToCopyMetadata: 'Не удалось скопировать метаданные',
        failedToKillSession: 'Не удалось завершить сессию',
        failedToArchiveSession: 'Не удалось архивировать сессию',
        connectionStatus: 'Статус подключения',
        created: 'Создано',
        lastUpdated: 'Последнее обновление',
        sequence: 'Последовательность',
        quickActions: 'Быстрые действия',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionNeedsHappyAgent: 'Resume is unavailable on this machine. Run `happy-agent auth login` to enable it.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Claude or Codex identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        killSessionSubtitle: 'Немедленно завершить сессию',
        archiveSessionSubtitle: 'Архивировать эту сессию и остановить её',
        metadata: 'Метаданные',
        host: 'Хост',
        path: 'Путь',
        operatingSystem: 'Операционная система',
        processId: 'ID процесса',
        happyHome: 'Домашний каталог Happy',
        copyMetadata: 'Копировать метаданные',
        agentState: 'Состояние агента',
        controlledByUser: 'Управляется пользователем',
        pendingRequests: 'Ожидающие запросы',
        activity: 'Активность',
        thinking: 'Думает',
        thinkingSince: 'Думает с',
        cliVersion: 'Версия CLI',
        cliVersionOutdated: 'Требуется обновление CLI',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Установлена версия ${currentVersion}. Обновите до ${requiredVersion} или новее`,
        updateCliInstructions: 'Пожалуйста, выполните npm install -g happy@latest',
        deleteSession: 'Удалить сессию',
        deleteSessionSubtitle: 'Удалить эту сессию навсегда',
        deleteSessionConfirm: 'Удалить сессию навсегда?',
        deleteSessionWarning: 'Это действие нельзя отменить. Все сообщения и данные, связанные с этой сессией, будут удалены навсегда.',
        failedToDeleteSession: 'Не удалось удалить сессию',
        sessionDeleted: 'Сессия успешно удалена',
        worktreeCleanupTitle: 'Удалить Worktree?',
        worktreeCleanupMessage: 'В Worktree нет незафиксированных изменений. Хотите удалить файлы Worktree?',
        worktreeCleanupDelete: 'Удалить Worktree',
        worktreeCleanupKeep: 'Сохранить файлы',
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Готовы к программированию?',
            installCli: 'Установите Happy CLI',
            runIt: 'Запустите его',
            scanQrCode: 'Отсканируйте QR-код',
            openCamera: 'Открыть камеру',
        },
        agentGoalBar: {
            currentGoal: 'Текущая цель',
            accessibilityLabel: ({ goal }: { goal: string }) => `Текущая цель: ${goal}`,
            clearGoal: 'Очистить цель',
            stopGoal: 'Остановить цель',
            editGoal: 'Изменить цель',
        },
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Контекст ${used} из ${total} токенов, ${percent}%`,
            limitFiveHour: 'Лимит 5 часов',
            limitSevenDay: 'Лимит 7 дней',
            limitResets: ({ time }: { time: string }) => `сброс ${time}`,
            limitAsOf: ({ age }: { age: string }) => `данные ${age} назад`,
            limitRemaining: ({ percent }: { percent: number }) => `осталось ${percent}%`,
        },
    },

    profile: {
        userProfile: 'Профиль пользователя',
        details: 'Детали',
        firstName: 'Имя',
        lastName: 'Фамилия',
        username: 'Имя пользователя',
        status: 'Статус',
    },


    status: {
        connected: 'подключено',
        connecting: 'подключение',
        disconnected: 'отключено',
        error: 'ошибка',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `в сети ${time}`,
        permissionRequired: 'требуется разрешение',
        activeNow: 'Активен сейчас',
        unknown: 'неизвестно',
        unread: 'новые результаты',
    },

    time: {
        justNow: 'только что',
        minutesAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'минуту', few: 'минуты', many: 'минут' })} назад`,
        hoursAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'час', few: 'часа', many: 'часов' })} назад`,
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'день', few: 'дня', many: 'дней' })} назад`,
    },

    session: {
        inputPlaceholder: 'Введите сообщение...',
        inactiveArchived: 'Эта сессия неактивна.',
        resumeFromTerminal: 'Чтобы возобновить её из терминала:',
        newChat: 'Новый чат',
        statusBarContext: 'Контекст',
        statusBarPathTitle: 'Рабочая директория',
        forkAction: 'Форкнуть сессию',
        forkSubtitle: 'Продолжить в новой сессии с тем же контекстом',
        duplicateAction: 'Откатиться к сообщению…',
        duplicateSubtitle: 'Вернуться к выбранной точке и попробовать иначе',
        forkFromHere: 'Форкнуть отсюда',
        duplicateSheetTitle: 'Выберите точку отката',
        duplicateSheetSubtitle: 'Новая сессия сохранит выбранный ход целиком (ваше сообщение и ответ агента) и отбросит все следующие запросы.',
        duplicateSheetConfirm: 'Откатить',
        duplicateSheetEmpty: 'В этой сессии пока нет сообщений, к которым можно откатиться.',
        duplicateRowDisabled: 'К этому сообщению нельзя откатиться.',
        forkedFromLabel: 'Форкнуто из',
        forkedFromSubtitle: 'Открыть исходную сессию, из которой сделан форк',
        forkErrorOffline: 'Машина оффлайн. Форк доступен, только пока машина с сессией онлайн.',
        forkErrorMissingUuid: 'Выбранная точка отката больше не существует в исходной сессии — попробуйте форк без обрезки.',
        forkErrorMissingMetadata: 'Не хватает метаданных сессии для форка.',
        forkErrorGeneric: 'Не удалось форкнуть сессию.',
        forkClaudeOnly: 'Форк сейчас поддерживается только для Claude-сессий.',
    },

    commandPalette: {
        placeholder: 'Введите команду или поиск...',
    },

    agentInput: {
        permissionMode: {
            title: 'РЕЖИМ РАЗРЕШЕНИЙ',
            default: 'По умолчанию',
            acceptEdits: 'Принимать правки',
            plan: 'Режим планирования',
            dontAsk: 'Не спрашивать',
            bypassPermissions: 'YOLO режим',
            badgeAcceptAllEdits: 'Принимать все правки',
            badgeBypassAllPermissions: 'Обход всех разрешений',
            badgePlanMode: 'Режим планирования',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
            openclaw: 'OpenClaw',
        },
        model: {
            title: 'МОДЕЛЬ',
            configureInCli: 'Настройте модели в настройках CLI',
        },
        effort: {
            title: 'УСИЛИЕ',
        },
        codexPermissionMode: {
            title: 'РЕЖИМ РАЗРЕШЕНИЙ CODEX',
            default: 'Настройки CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            defaultDescription: 'спрашивать перед недоверенными командами',
            readOnlyDescription: 'без записи',
            safeYoloDescription: 'без запросов, песочница рабочей папки',
            yoloDescription: 'без запросов, полный доступ',
            badgeReadOnly: 'Только чтение',
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
            title: 'РЕЖИМ РАЗРЕШЕНИЙ',
            default: 'По умолчанию',
            autoEdit: 'Авто-редактирование',
            yolo: 'YOLO',
            plan: 'Планирование',
            badgeAutoEdit: 'Авто-редактирование',
            badgeYolo: 'YOLO',
            badgePlan: 'Планирование',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `Осталось ${percent}%`,
        },
        suggestion: {
            fileLabel: 'ФАЙЛ',
            folderLabel: 'ПАПКА',
        },
        noMachinesAvailable: 'Нет машин',
    },

    machineLauncher: {
        showLess: 'Показать меньше',
        showAll: ({ count }: { count: number }) => `Показать все (${count} ${plural({ count, one: 'путь', few: 'пути', many: 'путей' })})`,
        enterCustomPath: 'Ввести свой путь',
        offlineUnableToSpawn: 'Невозможно создать сессию, машина offline',
    },

    agentQuestion: {
        title: "Вопрос",
        submit: "Отправить ответ",
        chooseMultiple: "Выберите все подходящие",
        ownAnswer: "Свой ответ",
        ownAnswerPlaceholder: "Напишите свой ответ",
        submitFailed: "Не удалось отправить ответ",
        dismiss: "Скрыть",
        unsupportedTitle: "Неподдерживаемый запрос",
        unsupportedDescription: ({ kind }: { kind: string }) => `Эта версия Happy не может показать запрос «${kind}». Обновите приложение, чтобы ответить.`,
        moreQuestions: ({ count }: { count: number }) =>
            count === 1 ? "ещё 1 вопрос" : `${count} вопросов ещё`,
    },

    sidebar: {
        sessionsTitle: 'Happy',
        showArchived: 'Показать архив',
        hideArchived: 'Скрыть архив',
        newSession: 'Новая сессия',
        projects: "Проекты",
    },

    zen: {
        toggle: 'Дзен-режим',
    },

    toolView: {
        input: 'Входные данные',
        output: 'Результат',
    },

    toolGroup: {
        editedFile: 'Отредактированный файл',
        editedFiles: ({ count }: { count: number }) => `${plural({ count, one: 'Отредактирован', few: 'Отредактировано', many: 'Отредактировано' })} ${count} ${plural({ count, one: 'файл', few: 'файла', many: 'файлов' })}`,
        readFiles: ({ count }: { count: number }) => `${plural({ count, one: 'Прочитан', few: 'Прочитано', many: 'Прочитано' })} ${count} ${plural({ count, one: 'файл', few: 'файла', many: 'файлов' })}`,
        ranCommands: ({ count }: { count: number }) => `${plural({ count, one: 'Выполнена', few: 'Выполнено', many: 'Выполнено' })} ${count} ${plural({ count, one: 'команда', few: 'команды', many: 'команд' })}`,
        searched: ({ count }: { count: number }) => `${plural({ count, one: 'Выполнен', few: 'Выполнено', many: 'Выполнено' })} ${count} ${plural({ count, one: 'поиск', few: 'поиска', many: 'поисков' })}`,
        fetchedUrls: ({ count }: { count: number }) => `${plural({ count, one: 'Загружен', few: 'Загружено', many: 'Загружено' })} ${count} URL`,
        ranTasks: ({ count }: { count: number }) => `${plural({ count, one: 'Выполнена', few: 'Выполнено', many: 'Выполнено' })} ${count} ${plural({ count, one: 'задача', few: 'задачи', many: 'задач' })}`,
        usedTools: ({ count }: { count: number }) => `${plural({ count, one: 'Использован', few: 'Использовано', many: 'Использовано' })} ${count} ${plural({ count, one: 'инструмент', few: 'инструмента', many: 'инструментов' })}`,
        workedFor: ({ duration }: { duration: string }) => `Работало ${duration}`,
    },

    tools: {
        fullView: {
            description: 'Описание',
            inputParams: 'Входные параметры',
            output: 'Результат',
            error: 'Ошибка',
            completed: 'Инструмент выполнен успешно',
            noOutput: 'Результат не получен',
            running: 'Выполняется...',
            rawJsonDevMode: 'Исходный JSON (режим разработчика)',
        },
        taskView: {
            initializing: 'Инициализация агента...',
            moreTools: ({ count }: { count: number }) => `+${count} ещё ${plural({ count, one: 'инструмент', few: 'инструмента', many: 'инструментов' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Правка ${index} из ${total}`,
            replaceAll: 'Заменить все',
        },
        names: {
            task: 'Задача',
            terminal: 'Терминал',
            searchFiles: 'Поиск файлов',
            search: 'Поиск',
            searchContent: 'Поиск содержимого',
            listFiles: 'Список файлов',
            planProposal: 'Предложение плана',
            readFile: 'Чтение файла',
            editFile: 'Редактирование файла',
            writeFile: 'Запись файла',
            fetchUrl: 'Получение URL',
            readNotebook: 'Чтение блокнота',
            editNotebook: 'Редактирование блокнота',
            todoList: 'Список задач',
            webSearch: 'Веб-поиск',
            reasoning: 'Рассуждение',
            applyChanges: 'Обновить файл',
            viewDiff: 'Текущие изменения файла',
            question: 'Вопрос',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Терминал(команда: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Поиск(шаблон: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Поиск(путь: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Получение URL(адрес: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Редактирование блокнота(файл: ${path}, режим: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Список задач(количество: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Веб-поиск(запрос: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(шаблон: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} ${plural({ count, one: 'правка', few: 'правки', many: 'правок' })})`,
            readingFile: ({ file }: { file: string }) => `Чтение ${file}`,
            writingFile: ({ file }: { file: string }) => `Запись ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Изменение ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Изменение ${count} ${plural({ count, one: 'файла', few: 'файлов', many: 'файлов' })}`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} и ещё ${count}`,
            showingDiff: 'Показ изменений',
        },
        askUserQuestion: {
            submit: 'Отправить ответ',
            multipleQuestions: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'вопрос', few: 'вопроса', many: 'вопросов' })}`,
            other: 'Другое',
            otherDescription: 'Введите свой ответ',
            otherPlaceholder: 'Введите ваш ответ...',
        }
    },

    files: {
        changes: 'Изменения',
        searchPlaceholder: 'Поиск файлов...',
        detachedHead: 'отделённый HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} подготовлено • ${unstaged} не подготовлено`,
        notRepo: 'Не является git-репозиторием',
        notUnderGit: 'Эта папка не находится под управлением git',
        searching: 'Поиск файлов...',
        noFilesFound: 'Файлы не найдены',
        noFilesInProject: 'Файлов в проекте нет',
        tryDifferentTerm: 'Попробуйте другой поисковый запрос',
        searchResults: ({ count }: { count: number }) => `Результаты поиска (${count})`,
        projectRoot: 'Корень проекта',
        stagedChanges: ({ count }: { count: number }) => `Подготовленные изменения (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Неподготовленные изменения (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Загрузка ${fileName}...`,
        binaryFile: 'Бинарный файл',
        cannotDisplayBinary: 'Невозможно отобразить содержимое бинарного файла',
        diff: 'Различия',
        file: 'Файл',
        fileEmpty: 'Файл пустой',
        noChanges: 'Нет изменений для отображения',
        noChangesTitle: 'Нет изменений',
        noChangesSubtitle: 'Рабочее дерево чистое',
        deleted: 'Удалён',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'изменённый файл' : count < 5 ? 'изменённых файла' : 'изменённых файлов'}`,
        allFiles: 'Все файлы',
        addPanel: 'Добавить панель',
        closePanel: 'Закрыть панель',
        editFile: 'Редактировать',
        saveFile: 'Сохранить',
        failedToRead: 'Не удалось прочитать файл',
        failedToSave: 'Не удалось сохранить файл',
        fileConflict: 'Конфликт файла',
        fileConflictDescription: 'Файл был изменён на устройстве пока вы его редактировали. Перезагрузите чтобы увидеть актуальную версию.',
        reload: 'Перезагрузить',
        overwrite: 'Перезаписать',
    },
    sideChat: {
        panelTitle: 'Боковой чат',
        emptyTitle: 'Начните боковой чат',
        emptySubtitle: 'Спросите агента что-нибудь в стороне. Он наследует контекст этого чата, но остаётся изолированным — ничто здесь не затрагивает основной разговор.',
        startButton: 'Начать боковой чат',
        creating: 'Запуск бокового чата…',
        unavailable: 'Эта сессия пока не может начать боковой чат — дождитесь, когда агент выйдет в сеть.',
        composerPlaceholder: 'Написать в боковой чат…',
        expand: 'Открыть на весь экран',
        tabLabel: ({ index }: { index: number }) => `Боковой чат ${index}`,
        newChat: 'Новый боковой чат',
        close: 'Закрыть боковой чат',
    },




    updateBanner: {
        updateAvailable: 'Доступно обновление',
        pressToApply: 'Нажмите, чтобы применить обновление',
        whatsNew: 'Что нового',
        seeLatest: 'Посмотреть последние обновления и улучшения',
        nativeUpdateAvailable: 'Доступно обновление приложения',
        tapToUpdateAppStore: 'Нажмите для обновления в App Store',
        tapToUpdatePlayStore: 'Нажмите для обновления в Play Store',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Версия ${version}`,
        noEntriesAvailable: 'Записи журнала изменений недоступны.',
    },


    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Авторизация терминала',
        pasteUrlFromTerminal: 'Вставьте URL авторизации из вашего терминала',
        deviceLinkedSuccessfully: 'Устройство успешно связано',
        terminalConnectedSuccessfully: 'Терминал успешно подключен',
        invalidAuthUrl: 'Неверный URL авторизации',
        failedToConnectTerminal: 'Не удалось подключить терминал',
        cameraPermissionsRequiredToConnectTerminal: 'Для подключения терминала требуется доступ к камере',
        failedToLinkDevice: 'Не удалось связать устройство',
        cameraPermissionsRequiredToScanQr: 'Для сканирования QR-кодов требуется доступ к камере'
    },

    navigation: {
        // Navigation titles and screen headers
        whatsNew: 'Что нового',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Мобильный клиент Codex и Claude Code',
        subtitle: 'Сквозное шифрование, аккаунт хранится только на вашем устройстве.',
        createAccount: 'Создать аккаунт',
        linkOrRestoreAccount: 'Связать или восстановить аккаунт',
        loginWithMobileApp: 'Войти через мобильное приложение',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Нравится приложение?',
        feedbackPrompt: 'Мы будем рады вашему отзыву!',
        yesILoveIt: 'Да, мне нравится!',
        notReally: 'Не совсем'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} скопировано в буфер обмена`
    },

    machine: {
        offlineUnableToSpawn: 'Запуск отключен: машина offline',
        offlineHelp: '• Убедитесь, что компьютер online\n• Выполните `happy daemon status` для диагностики\n• Используете последнюю версию CLI? Обновите командой `npm install -g happy@latest`',
        launchNewSessionInDirectory: 'Запустить новую сессию в папке',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Переключено в режим ${mode}`,
        unknownEvent: 'Неизвестное событие',
        usageLimitUntil: ({ time }: { time: string }) => `Лимит использования достигнут до ${time}`,
        sentAsGoal: 'Отправлено в качестве цели',
        unknownTime: 'неизвестное время',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: 'Да, и не спрашивать для этой сессии',
            stopAndExplain: 'Остановить и объяснить, что делать',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Да, разрешить все правки в этой сессии',
            yesAllowEverything: 'Да, разрешить всё в этой сессии',
            yesForTool: 'Да, больше не спрашивать для этого инструмента',
            noTellClaude: 'Нет, дать обратную связь',
        }
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Язык',
        description: 'Выберите предпочтительный язык интерфейса приложения. Настройки синхронизируются на всех ваших устройствах.',
        currentLanguage: 'Текущий язык',
        automatic: 'Автоматически',
        automaticSubtitle: 'Определять по настройкам устройства',
        needsRestart: 'Язык изменён',
        needsRestartMessage: 'Приложение нужно перезапустить для применения новых языковых настроек.',
        restartNow: 'Перезапустить',
    },

    textSelection: {
        // Text selection screen
        selectText: 'Выделить диапазон текста',
        title: 'Выделить текст',
        noTextProvided: 'Текст не предоставлен',
        textNotFound: 'Текст не найден или устарел',
        textCopied: 'Текст скопирован в буфер обмена',
        failedToCopy: 'Не удалось скопировать текст в буфер обмена',
        noTextToCopy: 'Нет текста для копирования',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Код скопирован',
        copyFailed: 'Ошибка копирования',
        mermaidRenderFailed: 'Не удалось отобразить диаграмму mermaid',
    },




    imageUpload: {
        permissionTitle: 'Доступ к библиотеке фото',
        permissionMessage: 'Разрешите доступ к вашей библиотеке фото, чтобы прикреплять изображения к сообщениям.',
        limitTitle: 'Достигнут лимит изображений',
        limitMessage: ({ max }: { max: number }) => `Можно прикрепить не более ${max} изображений на сообщение.`,
        fileTooLargeTitle: 'Файл слишком большой',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" превышает лимит ${maxMb}МБ и не был добавлен.`,
        uploadFailedTitle: 'Ошибка загрузки',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'Одно изображение не удалось загрузить — оно не было отправлено.'
            : `${count} изображений не удалось загрузить — они не были отправлены.`,
        notSupportedTitle: 'Изображения не поддерживаются',
        notSupportedMessage: 'Этот агент не поддерживает вложения изображений. Изображения не были отправлены.',
    },


} as const;

export type TranslationsRu = typeof ru;
