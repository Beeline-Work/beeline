import type { TranslationStructure } from '../_default';

/**
 * Polish plural helper function
 * Polish has 3 plural forms: one, few, many
 * @param options - Object containing count and the three plural forms
 * @returns The appropriate form based on Polish plural rules
 */
function plural({ count, one, few, many }: { count: number; one: string; few: string; many: string }): string {
    const n = Math.abs(count);
    const n10 = n % 10;
    const n100 = n % 100;
    
    // Rule: 1 (but not 11)
    if (n === 1) return one;
    
    // Rule: 2-4 but not 12-14
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    
    // Rule: everything else (0, 5-19, 11, 12-14, etc.)
    return many;
}

/**
 * Polish translations for the Happy app
 * Must match the exact structure of the English translations
 */
export const pl: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Terminale',
        settings: 'Ustawienia',
    },


    common: {
        // Simple string constants
        cancel: 'Anuluj',
        authenticate: 'Uwierzytelnij',
        save: 'Zapisz',
        saveAs: 'Zapisz jako',
        error: 'Błąd',
        success: 'Sukces',
        ok: 'OK',
        continue: 'Kontynuuj',
        back: 'Wstecz',
        create: 'Utwórz',
        rename: 'Zmień nazwę',
        reset: 'Resetuj',
        logout: 'Wyloguj',
        yes: 'Tak',
        no: 'Nie',
        discard: 'Odrzuć',
        version: 'Wersja',
        copied: 'Skopiowano',
        copy: 'Kopiuj',
        scanning: 'Skanowanie...',
        urlPlaceholder: 'https://example.com',
        home: 'Główna',
        message: 'Wiadomość',
        files: 'Pliki',
        fileViewer: 'Przeglądarka plików',
        loading: 'Ładowanie...',
        retry: 'Ponów',
        delete: 'Usuń',
        optional: 'opcjonalnie',
    },

    profile: {
        userProfile: 'Profil użytkownika',
        details: 'Szczegóły',
        firstName: 'Imię',
        lastName: 'Nazwisko',
        username: 'Nazwa użytkownika',
        status: 'Status',
    },


    status: {
        connected: 'połączono',
        connecting: 'łączenie',
        disconnected: 'rozłączono',
        error: 'błąd',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `ostatnio widziano ${time}`,
        permissionRequired: 'wymagane uprawnienie',
        activeNow: 'Aktywny teraz',
        unknown: 'nieznane',
        unread: 'nowe wyniki',
    },

    time: {
        justNow: 'teraz',
        minutesAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'minuta', few: 'minuty', many: 'minut' })} temu`,
        hoursAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'godzina', few: 'godziny', many: 'godzin' })} temu`,
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'dzień', few: 'dni', many: 'dni' })} temu`,
    },

    connect: {
        enterUrlManually: 'Wprowadź URL ręcznie',
    },

    settings: {
        title: 'Ustawienia',
        github: 'GitHub',
        features: 'Funkcje',
        appearance: 'Wygląd',
        appearanceSubtitle: 'Dostosuj wygląd aplikacji',
        featuresTitle: 'Funkcje',
        featuresSubtitle: 'Włącz lub wyłącz funkcje aplikacji',
        about: 'O aplikacji',
        aboutFooter: 'Happy Coder to mobilny klient Codex i Claude Code. Jest w pełni szyfrowany end-to-end, a Twoje konto jest przechowywane tylko na Twoim urządzeniu. Nie jest powiązany z Anthropic.',
        whatsNew: 'Co nowego',
        whatsNewSubtitle: 'Zobacz najnowsze aktualizacje i ulepszenia',
        reportIssue: 'Zgłoś problem',
        privacyPolicy: 'Polityka prywatności',
        termsOfService: 'Warunki użytkowania',
        eula: 'EULA',
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'włączona' : 'wyłączona'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Motyw',
        themeDescription: 'Wybierz preferowaną kolorystykę',
        themeOptions: {
            adaptive: 'Adaptacyjny',
            light: 'Jasny',
            dark: 'Ciemny',
        },
        themeDescriptions: {
            adaptive: 'Dopasuj do ustawień systemu',
            light: 'Zawsze używaj jasnego motywu',
            dark: 'Zawsze używaj ciemnego motywu',
        },
        chat: 'Czat',
        chatDescription: 'Dostosuj wygląd wiadomości czatu',
        sessionStatusBar: 'Informacje o stanie sesji',
        sessionStatusBarDescription: 'Wybierz, gdzie wyświetlać gałąź, model, wysiłek i kontekst',
        sessionStatusDisplayOptions: {
            hidden: 'Ukryte',
            above: 'Nad polem wprowadzania',
            below: 'Pod polem wprowadzania',
        },
        usageLimitShowRemaining: 'Pokaż pozostały limit',
        usageLimitShowRemainingDescription: 'Wskaźniki limitu odliczają w dół zamiast w górę',
        userMessageBubbleColor: 'Kolor Twoich wiadomości',
        userMessageBubbleColorDescription: 'Ułatw znajdowanie swoich wiadomości w długich czatach',
        userMessageBubbleColorOptions: {
            blue: 'Niebieski',
            green: 'Zielony',
            purple: 'Fioletowy',
            rose: 'Różowy',
            sand: 'Piaskowy',
            gray: 'Szary',
        },
        display: 'Wyświetlanie',
        displayDescription: 'Kontroluj układ i odstępy',
        compactToolCalls: 'Kompaktowe wywołania narzędzi',
        compactToolCallsDescription: 'Pokazuj nieinteraktywne wywołania w jednym wierszu; otwórz wiersz, aby zobaczyć szczegóły',
        inlineToolCalls: 'Wbudowane wywołania narzędzi',
        inlineToolCallsDescription: 'Wyświetlaj wywołania narzędzi bezpośrednio w wiadomościach czatu',
        expandTodoLists: 'Rozwiń listy zadań',
        expandTodoListsDescription: 'Pokazuj wszystkie zadania zamiast tylko zmian',
        showLineNumbersInDiffs: 'Pokaż numery linii w różnicach',
        showLineNumbersInDiffsDescription: 'Wyświetlaj numery linii w różnicach kodu',
        showLineNumbersInToolViews: 'Pokaż numery linii w widokach narzędzi',
        showLineNumbersInToolViewsDescription: 'Wyświetlaj numery linii w różnicach widoków narzędzi',
        wrapLinesInDiffs: 'Zawijanie linii w różnicach',
        wrapLinesInDiffsDescription: 'Zawijaj długie linie zamiast przewijania poziomego w widokach różnic',
        diffStyle: 'Widok różnic',
        diffStyleDescription: 'Pokazuj różnice w jednej kolumnie (unified) lub obok siebie (split). Widok split działa tylko w przeglądarce.',
        diffStyleOptions: {
            unified: 'Unified',
            split: 'Split',
        },
        alwaysShowContextSize: 'Zawsze pokazuj rozmiar kontekstu',
        alwaysShowContextSizeDescription: 'Wyświetlaj użycie kontekstu nawet gdy nie jest blisko limitu',
        avatarStyle: 'Styl awatara',
        avatarStyleDescription: 'Wybierz wygląd awatara sesji',
        avatarOptions: {
            pixelated: 'Pikselowy',
            gradient: 'Gradientowy',
            brutalist: 'Brutalistyczny',
        },
        showFlavorIcons: 'Pokaż ikony dostawcy AI',
        showFlavorIconsDescription: 'Wyświetlaj ikony dostawcy AI na awatarach sesji',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Eksperymenty',
        experimentsDescription: 'Włącz eksperymentalne funkcje, które są nadal w rozwoju. Te funkcje mogą być niestabilne lub zmienić się bez ostrzeżenia.',
        experimentalFeatures: 'Funkcje eksperymentalne',
        experimentalFeaturesEnabled: 'Funkcje eksperymentalne włączone',
        experimentalFeaturesDisabled: 'Używane tylko stabilne funkcje',
        webFeatures: 'Funkcje webowe',
        webFeaturesDescription: 'Funkcje dostępne tylko w wersji webowej aplikacji.',
        enterToSend: 'Enter aby wysłać',
        enterToSendEnabled: 'Naciśnij Enter, aby wysłać (Shift+Enter dla nowej linii)',
        enterToSendDisabled: 'Enter wstawia nową linię',
        commandPalette: 'Paleta poleceń',
        commandPaletteEnabled: 'Naciśnij ⌘K, aby otworzyć',
        commandPaletteDisabled: 'Szybki dostęp do poleceń wyłączony',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Długie naciśnięcie otwiera modal kopiowania',
        hideInactiveSessions: 'Ukryj nieaktywne sesje',
        hideInactiveSessionsSubtitle: 'Wyświetlaj tylko aktywne czaty na liście',
        groupToolCalls: 'Grupuj wywołania narzędzi',
        groupToolCallsSubtitle: 'Zwijaj kolejne wywołania narzędzi w jeden kontener',
        privacy: 'Prywatność',
        privacyDescription: 'Całkowicie wyłącza wszystkie analizy i telemetrię. Żadne dane nie będą wysyłane do PostHog ani żadnego innego serwisu śledzącego.',
        disableAnalytics: 'Wyłącz analitykę',
        analyticsDisabled: 'Wszystkie śledzenie i telemetria wyłączone',
        analyticsEnabled: 'Anonimowa analityka użytkowania aktywna',
        imageUpload: 'Przesyłanie obrazów',
        imageUploadSubtitle: 'Dołączaj obrazy do wiadomości, aby obsługiwani agenci mogli je analizować',
    },

    errors: {
        networkError: 'Wystąpił błąd sieci',
        serverError: 'Wystąpił błąd serwera',
        unknownError: 'Wystąpił nieznany błąd',
        connectionTimeout: 'Przekroczono czas oczekiwania na połączenie',
        authenticationFailed: 'Uwierzytelnienie nie powiodło się',
        permissionDenied: 'Brak uprawnień',
        fileNotFound: 'Plik nie został znaleziony',
        invalidFormat: 'Nieprawidłowy format',
        operationFailed: 'Operacja nie powiodła się',
        tryAgain: 'Spróbuj ponownie',
        contactSupport: 'Skontaktuj się z pomocą techniczną, jeśli problem będzie się powtarzał',
        sessionNotFound: 'Sesja nie została znaleziona',
        voiceSessionFailed: 'Nie udało się uruchomić sesji głosowej',
        voiceServiceUnavailable: 'Usługa głosowa jest tymczasowo niedostępna',
        voiceLimitReachedTitle: 'Osiągnięto limit głosu',
        voiceHardLimitReached: ({ hours }: { hours: number }) => `Wykorzystałeś ${hours}+ godzin głosu w tym miesiącu. To jest maksymalny dozwolony limit. Możesz skonfigurować własnego agenta ElevenLabs w ustawieniach głosu, aby korzystać z własnego limitu.`,
        voiceConversationLimitReached: 'Osiągnąłeś maksymalną liczbę rozmów głosowych w tym miesiącu. Możliwe, że w przyszłości dodamy głosowe korzystanie na żądanie — prosimy o zgłoszenie na github.com/nicepkg/happy/issues, jeśli napotkasz ten limit.',
        oauthInitializationFailed: 'Nie udało się zainicjować przepływu OAuth',
        tokenStorageFailed: 'Nie udało się zapisać tokenów uwierzytelniania',
        oauthStateMismatch: 'Weryfikacja bezpieczeństwa nie powiodła się. Spróbuj ponownie',
        tokenExchangeFailed: 'Nie udało się wymienić kodu autoryzacji',
        oauthAuthorizationDenied: 'Autoryzacja została odrzucona',
        webViewLoadFailed: 'Nie udało się załadować strony uwierzytelniania',
        failedToLoadProfile: 'Nie udało się załadować profilu użytkownika',
        userNotFound: 'Użytkownik nie został znaleziony',
        sessionDeleted: 'Sesja została usunięta',
        sessionDeletedDescription: 'Ta sesja została trwale usunięta',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} musi być między ${min} a ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Ponów próbę za ${seconds} ${plural({ count: seconds, one: 'sekundę', few: 'sekundy', many: 'sekund' })}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Błąd ${code})`,
    },

    newSession: {
        title: 'Rozpocznij nową sesję',
        machineOffline: 'Maszyna jest offline',
        switchMachinesHint: '• Przełącz maszynę, klikając na nią powyżej',
    },

    sessionHistory: {
        // Used by session history screen
        empty: 'Nie znaleziono sesji',
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'dzień', few: 'dni', many: 'dni' })} temu`,
    },

    session: {
        inputPlaceholder: 'Wpisz wiadomość...',
        inactiveArchived: 'Ta sesja jest nieaktywna.',
        resumeFromTerminal: 'Aby wznowić ją z terminala:',
        newChat: 'Nowy czat',
        statusBarContext: 'Kontekst',
        statusBarPathTitle: 'Katalog roboczy',
        forkAction: 'Rozwidl sesję',
        forkSubtitle: 'Kontynuuj w nowej sesji z tym samym kontekstem',
        duplicateAction: 'Duplikuj od wiadomości…',
        duplicateSubtitle: 'Cofnij się do wybranego punktu i spróbuj inaczej',
        forkFromHere: 'Rozwidl od tego miejsca',
        duplicateSheetTitle: 'Wybierz punkt cofnięcia',
        duplicateSheetSubtitle: 'Nowa sesja zachowa wybraną turę w całości (twoja wiadomość i odpowiedź agenta) i odrzuci wszystkie kolejne wiadomości.',
        duplicateSheetConfirm: 'Duplikuj',
        duplicateSheetEmpty: 'W tej sesji nie ma jeszcze wiadomości, do których można się cofnąć.',
        duplicateRowDisabled: 'Tej wiadomości nie można użyć jako punktu cofnięcia.',
        forkedFromLabel: 'Rozwidlone z',
        forkedFromSubtitle: 'Otwórz sesję, z której powstało rozwidlenie',
        forkErrorOffline: 'Maszyna jest offline. Rozwidlenie jest dostępne tylko gdy maszyna sesji jest online.',
        forkErrorMissingUuid: 'Wybrany punkt cofnięcia nie istnieje już w sesji źródłowej — spróbuj rozwidlić bez przycinania.',
        forkErrorMissingMetadata: 'Brak metadanych sesji wymaganych do rozwidlenia.',
        forkErrorGeneric: 'Nie udało się rozwidlić sesji.',
        forkClaudeOnly: 'Rozwidlenie jest obecnie obsługiwane tylko dla sesji Claude.',
    },

    commandPalette: {
        placeholder: 'Wpisz polecenie lub wyszukaj...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Zakończ sesję',
        killSessionConfirm: 'Czy na pewno chcesz zakończyć tę sesję?',
        archiveSession: 'Zarchiwizuj sesję',
        archiveSessionConfirm: 'Czy na pewno chcesz zarchiwizować tę sesję?',
        happySessionIdCopied: 'ID sesji Happy skopiowane do schowka',
        failedToCopySessionId: 'Nie udało się skopiować ID sesji Happy',
        happySessionId: 'ID sesji Happy',
        claudeCodeSessionId: 'ID sesji Claude Code',
        claudeCodeSessionIdCopied: 'ID sesji Claude Code skopiowane do schowka',
        codexThreadId: 'ID wątku Codex',
        codexThreadIdCopied: 'ID wątku Codex skopiowane do schowka',
        aiProvider: 'Dostawca AI',
        failedToCopyClaudeCodeSessionId: 'Nie udało się skopiować ID sesji Claude Code',
        failedToCopyCodexThreadId: 'Nie udało się skopiować ID wątku Codex',
        metadataCopied: 'Metadane skopiowane do schowka',
        failedToCopyMetadata: 'Nie udało się skopiować metadanych',
        failedToKillSession: 'Nie udało się zakończyć sesji',
        failedToArchiveSession: 'Nie udało się zarchiwizować sesji',
        connectionStatus: 'Status połączenia',
        created: 'Utworzono',
        lastUpdated: 'Ostatnia aktualizacja',
        sequence: 'Sekwencja',
        quickActions: 'Szybkie akcje',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionNeedsHappyAgent: 'Resume is unavailable on this machine. Run `happy-agent auth login` to enable it.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Claude or Codex identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        killSessionSubtitle: 'Natychmiastowo zakończ sesję',
        archiveSessionSubtitle: 'Zarchiwizuj tę sesję i zatrzymaj ją',
        metadata: 'Metadane',
        host: 'Host',
        path: 'Ścieżka',
        operatingSystem: 'System operacyjny',
        processId: 'ID procesu',
        happyHome: 'Katalog domowy Happy',
        copyMetadata: 'Kopiuj metadane',
        agentState: 'Stan agenta',
        controlledByUser: 'Kontrolowany przez użytkownika',
        pendingRequests: 'Oczekujące żądania',
        activity: 'Aktywność',
        thinking: 'Myśli',
        thinkingSince: 'Myśli od',
        cliVersion: 'Wersja CLI',
        cliVersionOutdated: 'Wymagana aktualizacja CLI',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Zainstalowana wersja ${currentVersion}. Zaktualizuj do ${requiredVersion} lub nowszej`,
        updateCliInstructions: 'Proszę uruchomić npm install -g happy@latest',
        deleteSession: 'Usuń sesję',
        deleteSessionSubtitle: 'Trwale usuń tę sesję',
        deleteSessionConfirm: 'Usunąć sesję na stałe?',
        deleteSessionWarning: 'Ta operacja jest nieodwracalna. Wszystkie wiadomości i dane powiązane z tą sesją zostaną trwale usunięte.',
        failedToDeleteSession: 'Nie udało się usunąć sesji',
        sessionDeleted: 'Sesja została pomyślnie usunięta',
        worktreeCleanupTitle: 'Usunąć Worktree?',
        worktreeCleanupMessage: 'Worktree nie ma niezatwierdzonych zmian. Czy chcesz usunąć pliki Worktree?',
        worktreeCleanupDelete: 'Usuń Worktree',
        worktreeCleanupKeep: 'Zachowaj pliki',
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Gotowy do kodowania?',
            installCli: 'Zainstaluj Happy CLI',
            runIt: 'Uruchom je',
            scanQrCode: 'Zeskanuj kod QR',
            openCamera: 'Otwórz kamerę',
        },
        agentGoalBar: {
            currentGoal: 'Bieżący cel',
            accessibilityLabel: ({ goal }: { goal: string }) => `Bieżący cel: ${goal}`,
            clearGoal: 'Wyczyść cel',
            stopGoal: 'Zatrzymaj cel',
            editGoal: 'Edytuj cel',
        },
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Kontekst ${used} z ${total} tokenów, ${percent}%`,
            limitFiveHour: 'Limit 5-godzinny',
            limitSevenDay: 'Limit 7-dniowy',
            limitResets: ({ time }: { time: string }) => `reset ${time}`,
            limitAsOf: ({ age }: { age: string }) => `sprzed ${age}`,
            limitRemaining: ({ percent }: { percent: number }) => `pozostało ${percent}%`,
        },
    },

    agentInput: {
        permissionMode: {
            title: 'TRYB UPRAWNIEŃ',
            default: 'Domyślny',
            acceptEdits: 'Akceptuj edycje',
            plan: 'Tryb planowania',
            dontAsk: 'Nie pytaj',
            bypassPermissions: 'Tryb YOLO',
            badgeAcceptAllEdits: 'Akceptuj wszystkie edycje',
            badgeBypassAllPermissions: 'Omiń wszystkie uprawnienia',
            badgePlanMode: 'Tryb planowania',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
            openclaw: 'OpenClaw',
        },
        model: {
            title: 'MODEL',
            configureInCli: 'Skonfiguruj modele w ustawieniach CLI',
        },
        effort: {
            title: 'WYSIŁEK',
        },
        codexPermissionMode: {
            title: 'TRYB UPRAWNIEŃ CODEX',
            default: 'Ustawienia CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            defaultDescription: 'pytaj przed niezaufanymi poleceniami',
            readOnlyDescription: 'bez zapisu',
            safeYoloDescription: 'bez pytań, piaskownica obszaru roboczego',
            yoloDescription: 'bez pytań, pełny dostęp',
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
            title: 'TRYB UPRAWNIEŃ GEMINI',
            default: 'Domyślny',
            autoEdit: 'Auto edycja',
            yolo: 'YOLO',
            plan: 'Planowanie',
            badgeAutoEdit: 'Auto edycja',
            badgeYolo: 'YOLO',
            badgePlan: 'Planowanie',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `Pozostało ${percent}%`,
        },
        suggestion: {
            fileLabel: 'PLIK',
            folderLabel: 'FOLDER',
        },
        noMachinesAvailable: 'Brak maszyn',
    },

    machineLauncher: {
        showLess: 'Pokaż mniej',
        showAll: ({ count }: { count: number }) => `Pokaż wszystkie (${count} ${plural({ count, one: 'ścieżka', few: 'ścieżki', many: 'ścieżek' })})`,
        enterCustomPath: 'Wprowadź niestandardową ścieżkę',
        offlineUnableToSpawn: 'Nie można utworzyć nowej sesji, offline',
    },

    agentQuestion: {
        title: "Pytanie",
        submit: "Wyślij odpowiedź",
        chooseMultiple: "Wybierz wszystkie pasujące",
        ownAnswer: "Własna odpowiedź",
        ownAnswerPlaceholder: "Wpisz odpowiedź",
        submitFailed: "Nie udało się wysłać odpowiedzi",
        dismiss: "Odrzuć",
        unsupportedTitle: "Nieobsługiwane żądanie",
        unsupportedDescription: ({ kind }: { kind: string }) => `Ta wersja Happy nie może pokazać żądania «${kind}». Zaktualizuj aplikację, aby odpowiedzieć.`,
        moreQuestions: ({ count }: { count: number }) =>
            count === 1 ? "jeszcze 1 pytanie" : `${count} pytań więcej`,
    },

    sidebar: {
        sessionsTitle: 'Happy',
        showArchived: 'Pokaż zarchiwizowane',
        hideArchived: 'Ukryj zarchiwizowane',
        newSession: 'Nowa sesja',
        projects: "Projekty",
    },

    zen: {
        toggle: 'Tryb zen',
    },

    toolView: {
        input: 'Wejście',
        output: 'Wyjście',
    },

    toolGroup: {
        editedFile: 'Edited file',
        editedFiles: ({ count }: { count: number }) => `${plural({ count, one: 'Edytowano 1 plik', few: `Edytowano ${count} pliki`, many: `Edytowano ${count} plików` })}`,
        readFiles: ({ count }: { count: number }) => `${plural({ count, one: 'Odczytano 1 plik', few: `Odczytano ${count} pliki`, many: `Odczytano ${count} plików` })}`,
        ranCommands: ({ count }: { count: number }) => `${plural({ count, one: 'Wykonano 1 polecenie', few: `Wykonano ${count} polecenia`, many: `Wykonano ${count} poleceń` })}`,
        searched: ({ count }: { count: number }) => `${plural({ count, one: 'Wyszukano 1 raz', few: `Wyszukano ${count} razy`, many: `Wyszukano ${count} razy` })}`,
        fetchedUrls: ({ count }: { count: number }) => `${plural({ count, one: 'Pobrano 1 URL', few: `Pobrano ${count} URLe`, many: `Pobrano ${count} URLi` })}`,
        ranTasks: ({ count }: { count: number }) => `${plural({ count, one: 'Wykonano 1 zadanie', few: `Wykonano ${count} zadania`, many: `Wykonano ${count} zadań` })}`,
        usedTools: ({ count }: { count: number }) => `${plural({ count, one: 'Użyto 1 narzędzie', few: `Użyto ${count} narzędzia`, many: `Użyto ${count} narzędzi` })}`,
        workedFor: ({ duration }: { duration: string }) => `Worked ${duration}`,
    },

    tools: {
        fullView: {
            description: 'Opis',
            inputParams: 'Parametry wejściowe',
            output: 'Wyjście',
            error: 'Błąd',
            completed: 'Narzędzie ukończone pomyślnie',
            noOutput: 'Nie wygenerowano żadnego wyjścia',
            running: 'Narzędzie działa...',
            rawJsonDevMode: 'Surowy JSON (tryb deweloperski)',
        },
        taskView: {
            initializing: 'Inicjalizacja agenta...',
            moreTools: ({ count }: { count: number }) => `+${count} ${plural({ count, one: 'więcej narzędzie', few: 'więcej narzędzia', many: 'więcej narzędzi' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Edycja ${index} z ${total}`,
            replaceAll: 'Zamień wszystkie',
        },
        names: {
            task: 'Zadanie',
            terminal: 'Terminal',
            searchFiles: 'Wyszukaj pliki',
            search: 'Wyszukaj',
            searchContent: 'Wyszukaj zawartość',
            listFiles: 'Lista plików',
            planProposal: 'Propozycja planu',
            readFile: 'Czytaj plik',
            editFile: 'Edytuj plik',
            writeFile: 'Zapisz plik',
            fetchUrl: 'Pobierz URL',
            readNotebook: 'Czytaj notatnik',
            editNotebook: 'Edytuj notatnik',
            todoList: 'Lista zadań',
            webSearch: 'Wyszukiwanie w sieci',
            reasoning: 'Rozumowanie',
            applyChanges: 'Zaktualizuj plik',
            viewDiff: 'Bieżące zmiany pliku',
            question: 'Pytanie',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Wyszukaj(wzorzec: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Wyszukaj(ścieżka: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Pobierz URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Edytuj notatnik(plik: ${path}, tryb: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Lista zadań(liczba: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Wyszukiwanie w sieci(zapytanie: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(wzorzec: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} ${plural({ count, one: 'edycja', few: 'edycje', many: 'edycji' })})`,
            readingFile: ({ file }: { file: string }) => `Odczytywanie ${file}`,
            writingFile: ({ file }: { file: string }) => `Zapisywanie ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Modyfikowanie ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Modyfikowanie ${count} ${plural({ count, one: 'pliku', few: 'plików', many: 'plików' })}`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} i ${count} ${plural({ count, one: 'więcej', few: 'więcej', many: 'więcej' })}`,
            showingDiff: 'Pokazywanie zmian',
        },
        askUserQuestion: {
            submit: 'Wyślij odpowiedź',
            multipleQuestions: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'pytanie', few: 'pytania', many: 'pytań' })}`,
            other: 'Inne',
            otherDescription: 'Wpisz własną odpowiedź',
            otherPlaceholder: 'Wpisz swoją odpowiedź...',
        }
    },

    files: {
        changes: 'Zmiany',
        searchPlaceholder: 'Wyszukaj pliki...',
        detachedHead: 'odłączony HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} przygotowanych • ${unstaged} nieprzygotowanych`,
        notRepo: 'To nie jest repozytorium git',
        notUnderGit: 'Ten katalog nie jest pod kontrolą wersji git',
        searching: 'Wyszukiwanie plików...',
        noFilesFound: 'Nie znaleziono plików',
        noFilesInProject: 'Brak plików w projekcie',
        tryDifferentTerm: 'Spróbuj innego terminu wyszukiwania',
        searchResults: ({ count }: { count: number }) => `Wyniki wyszukiwania (${count})`,
        projectRoot: 'Katalog główny projektu',
        stagedChanges: ({ count }: { count: number }) => `Przygotowane zmiany (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Nieprzygotowane zmiany (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Ładowanie ${fileName}...`,
        binaryFile: 'Plik binarny',
        cannotDisplayBinary: 'Nie można wyświetlić zawartości pliku binarnego',
        diff: 'Różnice',
        file: 'Plik',
        fileEmpty: 'Plik jest pusty',
        noChanges: 'Brak zmian do wyświetlenia',
        noChangesTitle: 'Brak zmian',
        noChangesSubtitle: 'Drzewo robocze jest czyste',
        deleted: 'Usunięty',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'zmieniony plik' : 'zmienionych plików'}`,
        allFiles: 'Wszystkie pliki',
        addPanel: 'Dodaj panel',
        closePanel: 'Zamknij panel',
        editFile: 'Edytuj',
        saveFile: 'Zapisz',
        failedToRead: 'Nie udało się odczytać pliku',
        failedToSave: 'Nie udało się zapisać pliku',
        fileConflict: 'Konflikt pliku',
        fileConflictDescription: 'Ten plik został zmodyfikowany na urządzeniu podczas edycji. Załaduj ponownie aby zobaczyć najnowszą wersję.',
        reload: 'Załaduj ponownie',
        overwrite: 'Nadpisz',
    },
    sideChat: {
        panelTitle: 'Czat boczny',
        emptyTitle: 'Rozpocznij czat boczny',
        emptySubtitle: 'Zapytaj agenta o coś na boku. Dziedziczy kontekst tego czatu, ale pozostaje odizolowany — nic tutaj nie wpływa na główną rozmowę.',
        startButton: 'Rozpocznij czat boczny',
        creating: 'Uruchamianie czatu bocznego…',
        unavailable: 'Ta sesja nie może jeszcze rozpocząć czatu bocznego — poczekaj, aż agent będzie online.',
        composerPlaceholder: 'Napisz na czacie bocznym…',
        expand: 'Otwórz na pełnym ekranie',
        tabLabel: ({ index }: { index: number }) => `Czat boczny ${index}`,
        newChat: 'Nowy czat boczny',
        close: 'Zamknij czat boczny',
    },



    settingsLanguage: {
        // Language settings screen
        title: 'Język',
        description: 'Wybierz preferowany język interfejsu aplikacji. To ustawienie zostanie zsynchronizowane na wszystkich Twoich urządzeniach.',
        currentLanguage: 'Aktualny język',
        automatic: 'Automatycznie',
        automaticSubtitle: 'Wykrywaj na podstawie ustawień urządzenia',
        needsRestart: 'Język zmieniony',
        needsRestartMessage: 'Aplikacja musi zostać uruchomiona ponownie, aby zastosować nowe ustawienia języka.',
        restartNow: 'Uruchom ponownie',
    },


    updateBanner: {
        updateAvailable: 'Dostępna aktualizacja',
        pressToApply: 'Naciśnij, aby zastosować aktualizację',
        whatsNew: 'Co nowego',
        seeLatest: 'Zobacz najnowsze aktualizacje i ulepszenia',
        nativeUpdateAvailable: 'Dostępna aktualizacja aplikacji',
        tapToUpdateAppStore: 'Naciśnij, aby zaktualizować w App Store',
        tapToUpdatePlayStore: 'Naciśnij, aby zaktualizować w Sklepie Play',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Wersja ${version}`,
        noEntriesAvailable: 'Brak dostępnych wpisów dziennika zmian.',
    },


    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Uwierzytelnij terminal',
        pasteUrlFromTerminal: 'Wklej URL uwierzytelnienia z terminala',
        deviceLinkedSuccessfully: 'Urządzenie połączone pomyślnie',
        terminalConnectedSuccessfully: 'Terminal połączony pomyślnie',
        invalidAuthUrl: 'Nieprawidłowy URL uwierzytelnienia',
        failedToConnectTerminal: 'Nie udało się połączyć terminala',
        cameraPermissionsRequiredToConnectTerminal: 'Uprawnienia do kamery są wymagane do połączenia terminala',
        failedToLinkDevice: 'Nie udało się połączyć urządzenia',
        cameraPermissionsRequiredToScanQr: 'Uprawnienia do kamery są wymagane do skanowania kodów QR'
    },

    navigation: {
        // Navigation titles and screen headers
        whatsNew: 'Co nowego',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Mobilny klient Codex i Claude Code',
        subtitle: 'Szyfrowanie end-to-end, a Twoje konto jest przechowywane tylko na Twoim urządzeniu.',
        createAccount: 'Utwórz konto',
        linkOrRestoreAccount: 'Połącz lub przywróć konto',
        loginWithMobileApp: 'Zaloguj się przez aplikację mobilną',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Podoba Ci się aplikacja?',
        feedbackPrompt: 'Chcielibyśmy usłyszeć Twoją opinię!',
        yesILoveIt: 'Tak, uwielbiam ją!',
        notReally: 'Nie bardzo'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} skopiowano do schowka`
    },

    machine: {
        offlineUnableToSpawn: 'Launcher wyłączony, gdy maszyna jest offline',
        offlineHelp: '• Upewnij się, że komputer jest online\n• Uruchom `happy daemon status`, aby zdiagnozować\n• Czy używasz najnowszej wersji CLI? Zaktualizuj poleceniem `npm install -g happy@latest`',
        launchNewSessionInDirectory: 'Uruchom nową sesję w katalogu',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Przełączono na tryb ${mode}`,
        unknownEvent: 'Nieznane zdarzenie',
        usageLimitUntil: ({ time }: { time: string }) => `Osiągnięto limit użycia do ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: 'nieznany czas',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: 'Tak, i nie pytaj dla tej sesji',
            stopAndExplain: 'Zatrzymaj i wyjaśnij, co zrobić',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Tak, zezwól na wszystkie edycje podczas tej sesji',
            yesAllowEverything: 'Tak, zezwól na wszystko podczas tej sesji',
            yesForTool: 'Tak, nie pytaj ponownie dla tego narzędzia',
            noTellClaude: 'Nie, przekaż opinię',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: 'Wybierz zakres tekstu',
        title: 'Wybierz tekst',
        noTextProvided: 'Nie podano tekstu',
        textNotFound: 'Tekst nie został znaleziony lub wygasł',
        textCopied: 'Tekst skopiowany do schowka',
        failedToCopy: 'Nie udało się skopiować tekstu do schowka',
        noTextToCopy: 'Brak tekstu do skopiowania',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Kod skopiowany',
        copyFailed: 'Błąd kopiowania',
        mermaidRenderFailed: 'Nie udało się wyświetlić diagramu mermaid',
    },




    imageUpload: {
        permissionTitle: 'Dostęp do biblioteki zdjęć',
        permissionMessage: 'Zezwól na dostęp do biblioteki zdjęć, aby załączać obrazy do wiadomości.',
        limitTitle: 'Osiągnięto limit obrazów',
        limitMessage: ({ max }: { max: number }) => `Możesz dołączyć maksymalnie ${max} obrazów na wiadomość.`,
        fileTooLargeTitle: 'Plik zbyt duży',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" przekracza limit ${maxMb}MB i nie został dodany.`,
        uploadFailedTitle: 'Przesyłanie nieudane',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'Nie udało się przesłać jednego zdjęcia i nie zostało wysłane.'
            : `Nie udało się przesłać ${count} zdjęć i nie zostały wysłane.`,
        notSupportedTitle: 'Obrazy nieobsługiwane',
        notSupportedMessage: 'Ten agent nie obsługuje załączników obrazów. Obrazy nie zostały wysłane.',
    },


} as const;

export type TranslationsPl = typeof pl;
