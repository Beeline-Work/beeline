import type { TranslationStructure } from '../_default';

/**
 * Italian plural helper function
 * Italian has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Italian plural rules
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

/**
 * Italian translations for the Happy app
 * Must match the exact structure of the English translations
 */
export const it: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Terminali',
        settings: 'Impostazioni',
    },


    common: {
        // Simple string constants
        cancel: 'Annulla',
        authenticate: 'Autentica',
        save: 'Salva',
        error: 'Errore',
        success: 'Successo',
        ok: 'OK',
        continue: 'Continua',
        back: 'Indietro',
        create: 'Crea',
        rename: 'Rinomina',
        reset: 'Ripristina',
        logout: 'Esci',
        yes: 'Sì',
        no: 'No',
        discard: 'Scarta',
        version: 'Versione',
        copied: 'Copiato',
        copy: 'Copia',
        scanning: 'Scansione...',
        urlPlaceholder: 'https://esempio.com',
        home: 'Home',
        message: 'Messaggio',
        files: 'File',
        fileViewer: 'Visualizzatore file',
        loading: 'Caricamento...',
        retry: 'Riprova',
        delete: 'Elimina',
        optional: 'opzionale',
        saveAs: 'Salva con nome',
    },

    profile: {
        userProfile: 'Profilo utente',
        details: 'Dettagli',
        firstName: 'Nome',
        lastName: 'Cognome',
        username: 'Nome utente',
        status: 'Stato',
    },

    status: {
        connected: 'connesso',
        connecting: 'connessione in corso',
        disconnected: 'disconnesso',
        error: 'errore',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `visto l'ultima volta ${time}`,
        permissionRequired: 'permesso richiesto',
        activeNow: 'Attivo ora',
        unknown: 'sconosciuto',
        unread: 'nuovi risultati',
    },

    time: {
        justNow: 'proprio ora',
        minutesAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'minuto' : 'minuti'} fa`,
        hoursAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'ora' : 'ore'} fa`,
        daysAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'giorno' : 'giorni'} fa`,
    },

    connect: {
        enterUrlManually: 'Inserisci URL manualmente',
    },

    settings: {
        title: 'Impostazioni',
        github: 'GitHub',
        features: 'Funzionalità',
        appearance: 'Aspetto',
        appearanceSubtitle: 'Personalizza l\'aspetto dell\'app',
        featuresTitle: 'Funzionalità',
        featuresSubtitle: 'Abilita o disabilita le funzionalità dell\'app',
        about: 'Informazioni',
        aboutFooter: 'Happy Coder è un client mobile per Codex e Claude Code. È completamente cifrato end-to-end e il tuo account è memorizzato solo sul tuo dispositivo. Non affiliato con Anthropic.',
        whatsNew: 'Novità',
        whatsNewSubtitle: 'Scopri gli ultimi aggiornamenti e miglioramenti',
        reportIssue: 'Segnala un problema',
        privacyPolicy: 'Informativa sulla privacy',
        termsOfService: 'Termini di servizio',
        eula: 'EULA',
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'abilitata' : 'disabilitata'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Tema',
        themeDescription: 'Scegli lo schema di colori preferito',
        themeOptions: {
            adaptive: 'Adattivo',
            light: 'Chiaro',
            dark: 'Scuro',
        },
        themeDescriptions: {
            adaptive: 'Segui le impostazioni di sistema',
            light: 'Usa sempre il tema chiaro',
            dark: 'Usa sempre il tema scuro',
        },
        chat: 'Chat',
        chatDescription: 'Personalizza l\'aspetto dei messaggi della chat',
        sessionStatusBar: 'Informazioni sullo stato della sessione',
        sessionStatusBarDescription: 'Scegli dove mostrare branch, modello, impegno e contesto',
        sessionStatusDisplayOptions: {
            hidden: 'Nascosto',
            above: 'Sopra il compositore',
            below: 'Sotto il compositore',
        },
        usageLimitShowRemaining: 'Mostra la quota rimanente',
        usageLimitShowRemainingDescription: 'Gli indicatori di limite contano alla rovescia invece che in avanti',
        userMessageBubbleColor: 'Colore dei tuoi messaggi',
        userMessageBubbleColorDescription: 'Rendi i tuoi messaggi più facili da trovare nelle chat lunghe',
        userMessageBubbleColorOptions: {
            blue: 'Blu',
            green: 'Verde',
            purple: 'Viola',
            rose: 'Rosa',
            sand: 'Sabbia',
            gray: 'Grigio',
        },
        display: 'Schermo',
        displayDescription: 'Controlla layout e spaziatura',
        compactToolCalls: 'Chiamate strumenti compatte',
        compactToolCallsDescription: 'Mostra le chiamate non interattive su una riga; apri una riga per i dettagli',
        inlineToolCalls: 'Chiamate strumenti inline',
        inlineToolCallsDescription: 'Mostra le chiamate agli strumenti direttamente nei messaggi di chat',
        expandTodoLists: 'Espandi liste di attività',
        expandTodoListsDescription: 'Mostra tutte le attività invece dei soli cambiamenti',
        showLineNumbersInDiffs: 'Mostra numeri di riga nelle differenze',
        showLineNumbersInDiffsDescription: 'Mostra i numeri di riga nei diff del codice',
        showLineNumbersInToolViews: 'Mostra numeri di riga nelle viste strumenti',
        showLineNumbersInToolViewsDescription: 'Mostra i numeri di riga nei diff delle viste strumenti',
        wrapLinesInDiffs: 'A capo nelle differenze',
        wrapLinesInDiffsDescription: 'A capo delle righe lunghe invece dello scorrimento orizzontale nelle viste diff',
        diffStyle: 'Vista diff',
        diffStyleDescription: 'Mostra le differenze in una sola colonna (unified) o affiancate (split). La vista split è disponibile solo sul web.',
        diffStyleOptions: {
            unified: 'Unified',
            split: 'Split',
        },
        alwaysShowContextSize: 'Mostra sempre dimensione contesto',
        alwaysShowContextSizeDescription: 'Mostra l\'uso del contesto anche quando non è vicino al limite',
        avatarStyle: 'Stile avatar',
        avatarStyleDescription: 'Scegli l\'aspetto dell\'avatar di sessione',
        avatarOptions: {
            pixelated: 'Pixelato',
            gradient: 'Gradiente',
            brutalist: 'Brutalista',
        },
        showFlavorIcons: 'Mostra icone provider IA',
        showFlavorIconsDescription: 'Mostra le icone del provider IA sugli avatar di sessione',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Esperimenti',
        experimentsDescription: 'Abilita funzionalità sperimentali ancora in sviluppo. Queste funzionalità possono essere instabili o cambiare senza preavviso.',
        experimentalFeatures: 'Funzionalità sperimentali',
        experimentalFeaturesEnabled: 'Funzionalità sperimentali abilitate',
        experimentalFeaturesDisabled: 'Usando solo funzionalità stabili',
        webFeatures: 'Funzionalità web',
        webFeaturesDescription: 'Funzionalità disponibili solo nella versione web dell\'app.',
        enterToSend: 'Invio con Enter',
        enterToSendEnabled: 'Premi Invio per inviare (Maiusc+Invio per una nuova riga)',
        enterToSendDisabled: 'Invio inserisce una nuova riga',
        commandPalette: 'Palette comandi',
        commandPaletteEnabled: 'Premi ⌘K per aprire',
        commandPaletteDisabled: 'Accesso rapido ai comandi disabilitato',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Pressione lunga apre la finestra di copia',
        hideInactiveSessions: 'Nascondi sessioni inattive',
        hideInactiveSessionsSubtitle: 'Mostra solo le chat attive nella tua lista',
        groupToolCalls: 'Raggruppa chiamate agli strumenti',
        groupToolCallsSubtitle: 'Comprimi le chiamate consecutive agli strumenti in un unico contenitore',
        privacy: 'Privacy',
        privacyDescription: 'Disabilita completamente tutte le analisi e la telemetria. Nessun dato verrà inviato a PostHog o ad altri servizi di tracciamento.',
        disableAnalytics: 'Disabilita analisi',
        analyticsDisabled: 'Tutto il tracciamento e la telemetria disabilitati',
        analyticsEnabled: 'Analisi anonime di utilizzo attive',
        imageUpload: 'Caricamento immagini',
        imageUploadSubtitle: 'Allega immagini ai messaggi per farle analizzare dagli agenti supportati',
    },

    errors: {
        networkError: 'Si è verificato un errore di rete',
        serverError: 'Si è verificato un errore del server',
        unknownError: 'Si è verificato un errore sconosciuto',
        connectionTimeout: 'Connessione scaduta',
        authenticationFailed: 'Autenticazione non riuscita',
        permissionDenied: 'Permesso negato',
        fileNotFound: 'File non trovato',
        invalidFormat: 'Formato non valido',
        operationFailed: 'Operazione non riuscita',
        tryAgain: 'Per favore riprova',
        contactSupport: 'Contatta l\'assistenza se il problema persiste',
        sessionNotFound: 'Sessione non trovata',
        voiceSessionFailed: 'Avvio della sessione vocale non riuscito',
        voiceServiceUnavailable: 'Il servizio vocale non è temporaneamente disponibile',
        voiceLimitReachedTitle: 'Limite vocale raggiunto',
        voiceHardLimitReached: ({ hours }: { hours: number }) => `Hai utilizzato ${hours}+ ore di voce questo mese. Questo è il massimo consentito. Puoi configurare il tuo agente ElevenLabs nelle impostazioni vocali per utilizzare la tua quota.`,
        voiceConversationLimitReached: 'Hai raggiunto il numero massimo di conversazioni vocali questo mese. Potremmo aggiungere l\'uso vocale su richiesta in futuro — per favore apri un issue su github.com/nicepkg/happy/issues se raggiungi questo limite.',
        oauthInitializationFailed: 'Impossibile inizializzare il flusso OAuth',
        tokenStorageFailed: 'Impossibile salvare i token di autenticazione',
        oauthStateMismatch: 'Convalida di sicurezza non riuscita. Riprova',
        tokenExchangeFailed: 'Impossibile scambiare il codice di autorizzazione',
        oauthAuthorizationDenied: 'Autorizzazione negata',
        webViewLoadFailed: 'Impossibile caricare la pagina di autenticazione',
        failedToLoadProfile: 'Impossibile caricare il profilo utente',
        userNotFound: 'Utente non trovato',
        sessionDeleted: 'La sessione è stata eliminata',
        sessionDeletedDescription: 'Questa sessione è stata rimossa definitivamente',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} deve essere tra ${min} e ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Riprova tra ${seconds} ${seconds === 1 ? 'secondo' : 'secondi'}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Errore ${code})`,
    },

    newSession: {
        title: 'Avvia nuova sessione',
        machineOffline: 'La macchina è offline',
        switchMachinesHint: '• Cambia macchina cliccando sulla macchina sopra',
    },

    sessionHistory: {
        // Used by session history screen
        empty: 'Nessuna sessione trovata',
        daysAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'giorno' : 'giorni'} fa`,
    },

    session: {
        inputPlaceholder: 'Scrivi un messaggio ...',
        inactiveArchived: 'Questa sessione è inattiva.',
        resumeFromTerminal: 'Per riprenderla dal terminale:',
        newChat: 'Nuova chat',
        statusBarContext: 'Contesto',
        statusBarPathTitle: 'Directory di lavoro',
        forkAction: 'Biforca sessione',
        forkSubtitle: 'Continua in una nuova sessione con lo stesso contesto',
        duplicateAction: 'Duplica da un messaggio…',
        duplicateSubtitle: 'Torna a un punto scelto e riprova',
        forkFromHere: 'Biforca da qui',
        duplicateSheetTitle: 'Scegli un punto di ritorno',
        duplicateSheetSubtitle: 'La nuova sessione manterrà il turno scelto completo (il tuo messaggio e la risposta dell\'agente) e scarterà i messaggi successivi.',
        duplicateSheetConfirm: 'Duplica',
        duplicateSheetEmpty: 'Nessun messaggio idoneo per il ritorno in questa sessione.',
        duplicateRowDisabled: 'Questo messaggio non può essere usato come punto di ritorno.',
        forkedFromLabel: 'Biforcato da',
        forkedFromSubtitle: 'Apri la sessione da cui è stata creata la biforcazione',
        forkErrorOffline: 'La macchina è offline. La biforcazione è disponibile solo mentre la macchina della sessione è online.',
        forkErrorMissingUuid: 'Il punto di ritorno scelto non esiste più nella sessione di origine — prova a biforcare senza troncare.',
        forkErrorMissingMetadata: 'Mancano i metadati della sessione necessari per biforcare.',
        forkErrorGeneric: 'Impossibile biforcare la sessione.',
        forkClaudeOnly: 'La biforcazione è attualmente supportata solo per le sessioni Claude.',
    },

    commandPalette: {
        placeholder: 'Digita un comando o cerca...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Termina sessione',
        killSessionConfirm: 'Sei sicuro di voler terminare questa sessione?',
        archiveSession: 'Archivia sessione',
        archiveSessionConfirm: 'Sei sicuro di voler archiviare questa sessione?',
        happySessionIdCopied: 'ID sessione Happy copiato negli appunti',
        failedToCopySessionId: 'Impossibile copiare l\'ID sessione Happy',
        happySessionId: 'ID sessione Happy',
        claudeCodeSessionId: 'ID sessione Claude Code',
        claudeCodeSessionIdCopied: 'ID sessione Claude Code copiato negli appunti',
        codexThreadId: 'ID thread Codex',
        codexThreadIdCopied: 'ID thread Codex copiato negli appunti',
        aiProvider: 'Provider IA',
        failedToCopyClaudeCodeSessionId: 'Impossibile copiare l\'ID sessione Claude Code',
        failedToCopyCodexThreadId: 'Impossibile copiare l\'ID thread Codex',
        metadataCopied: 'Metadati copiati negli appunti',
        failedToCopyMetadata: 'Impossibile copiare i metadati',
        failedToKillSession: 'Impossibile terminare la sessione',
        failedToArchiveSession: 'Impossibile archiviare la sessione',
        connectionStatus: 'Stato connessione',
        created: 'Creato',
        lastUpdated: 'Ultimo aggiornamento',
        sequence: 'Sequenza',
        quickActions: 'Azioni rapide',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionNeedsHappyAgent: 'Resume is unavailable on this machine. Run `happy-agent auth login` to enable it.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Claude or Codex identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        killSessionSubtitle: 'Termina immediatamente la sessione',
        archiveSessionSubtitle: 'Archivia questa sessione e fermala',
        metadata: 'Metadati',
        host: 'Host',
        path: 'Percorso',
        operatingSystem: 'Sistema operativo',
        processId: 'ID processo',
        happyHome: 'Happy Home',
        copyMetadata: 'Copia metadati',
        agentState: 'Stato agente',
        controlledByUser: 'Controllato dall\'utente',
        pendingRequests: 'Richieste in sospeso',
        activity: 'Attività',
        thinking: 'Pensando',
        thinkingSince: 'Pensando da',
        cliVersion: 'Versione CLI',
        cliVersionOutdated: 'Aggiornamento CLI richiesto',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Versione ${currentVersion} installata. Aggiorna a ${requiredVersion} o successiva`,
        updateCliInstructions: 'Esegui npm install -g happy@latest',
        deleteSession: 'Elimina sessione',
        deleteSessionSubtitle: 'Rimuovi definitivamente questa sessione',
        deleteSessionConfirm: 'Eliminare definitivamente la sessione?',
        deleteSessionWarning: 'Questa azione non può essere annullata. Tutti i messaggi e i dati associati a questa sessione verranno eliminati definitivamente.',
        failedToDeleteSession: 'Impossibile eliminare la sessione',
        sessionDeleted: 'Sessione eliminata con successo',
        worktreeCleanupTitle: 'Eliminare Worktree?',
        worktreeCleanupMessage: 'Il Worktree non ha modifiche non confermate. Vuoi eliminare i file del Worktree?',
        worktreeCleanupDelete: 'Elimina Worktree',
        worktreeCleanupKeep: 'Conserva file',

    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Pronto a programmare?',
            installCli: 'Installa la CLI Happy',
            runIt: 'Avviala',
            scanQrCode: 'Scansiona il codice QR',
            openCamera: 'Apri fotocamera',
        },
        agentGoalBar: {
            currentGoal: 'Obiettivo attuale',
            accessibilityLabel: ({ goal }: { goal: string }) => `Obiettivo attuale: ${goal}`,
            clearGoal: 'Cancella obiettivo',
            stopGoal: 'Ferma obiettivo',
            editGoal: 'Modifica obiettivo',
        },
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Contesto ${used} di ${total} token, ${percent}%`,
            limitFiveHour: 'Limite di 5 ore',
            limitSevenDay: 'Limite di 7 giorni',
            limitResets: ({ time }: { time: string }) => `si azzera ${time}`,
            limitAsOf: ({ age }: { age: string }) => `${age} fa`,
            limitRemaining: ({ percent }: { percent: number }) => `${percent}% rimanente`,
        },
    },

    agentInput: {
        permissionMode: {
            title: 'MODALITÀ PERMESSI',
            default: 'Predefinito',
            acceptEdits: 'Accetta modifiche',
            plan: 'Modalità piano',
            dontAsk: 'Non chiedere',
            bypassPermissions: 'Modalità YOLO',
            badgeAcceptAllEdits: 'Accetta tutte le modifiche',
            badgeBypassAllPermissions: 'Bypassa tutti i permessi',
            badgePlanMode: 'Modalità piano',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
            openclaw: 'OpenClaw',
        },
        model: {
            title: 'MODELLO',
            configureInCli: 'Configura i modelli nelle impostazioni CLI',
        },
        effort: {
            title: 'IMPEGNO',
        },
        codexPermissionMode: {
            title: 'MODALITÀ PERMESSI CODEX',
            default: 'Impostazioni CLI',
            readOnly: 'Modalità sola lettura',
            safeYolo: 'YOLO sicuro',
            yolo: 'YOLO',
            defaultDescription: 'chiedi prima dei comandi non attendibili',
            readOnlyDescription: 'nessuna scrittura',
            safeYoloDescription: "nessuna richiesta, sandbox dell'area di lavoro",
            yoloDescription: 'nessuna richiesta, accesso completo',
            badgeReadOnly: 'Modalità sola lettura',
            badgeSafeYolo: 'YOLO sicuro',
            badgeYolo: 'YOLO',
        },
        codexModel: {
            title: 'MODELLO CODEX',
            gpt5CodexLow: 'gpt-5-codex basso',
            gpt5CodexMedium: 'gpt-5-codex medio',
            gpt5CodexHigh: 'gpt-5-codex alto',
            gpt5Minimal: 'GPT-5 Minimo',
            gpt5Low: 'GPT-5 Basso',
            gpt5Medium: 'GPT-5 Medio',
            gpt5High: 'GPT-5 Alto',
        },
        geminiPermissionMode: {
            title: 'MODALITÀ PERMESSI GEMINI',
            default: 'Predefinito',
            autoEdit: 'Modifica automatica',
            yolo: 'YOLO',
            plan: 'Pianificazione',
            badgeAutoEdit: 'Modifica automatica',
            badgeYolo: 'YOLO',
            badgePlan: 'Pianificazione',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% restante`,
        },
        suggestion: {
            fileLabel: 'FILE',
            folderLabel: 'CARTELLA',
        },
        noMachinesAvailable: 'Nessuna macchina',
    },

    machineLauncher: {
        showLess: 'Mostra meno',
        showAll: ({ count }: { count: number }) => `Mostra tutto (${count} percorsi)`,
        enterCustomPath: 'Inserisci percorso personalizzato',
        offlineUnableToSpawn: 'Impossibile avviare una nuova sessione, offline',
    },

    agentQuestion: {
        title: "Domanda",
        submit: "Invia risposta",
        chooseMultiple: "Scegli tutte quelle pertinenti",
        ownAnswer: "La tua risposta",
        ownAnswerPlaceholder: "Scrivi una risposta",
        submitFailed: "Impossibile inviare la risposta",
        dismiss: "Ignora",
        unsupportedTitle: "Richiesta non supportata",
        unsupportedDescription: ({ kind }: { kind: string }) => `Questa versione di Happy non può mostrare una richiesta «${kind}». Aggiorna l'app per rispondere.`,
        moreQuestions: ({ count }: { count: number }) =>
            count === 1 ? "1 altra domanda" : `${count} altre domande`,
    },

    sidebar: {
        sessionsTitle: 'Happy',
        showArchived: 'Mostra archiviate',
        hideArchived: 'Nascondi archiviate',
        newSession: 'Nuova sessione',
        projects: "Progetti",
    },

    zen: {
        toggle: 'Modalità zen',
    },

    toolView: {
        input: 'Input',
        output: 'Output',
    },

    toolGroup: {
        editedFile: 'Edited file',
        editedFiles: ({ count }: { count: number }) => count === 1 ? 'Modificato 1 file' : `Modificati ${count} file`,
        readFiles: ({ count }: { count: number }) => count === 1 ? 'Letto 1 file' : `Letti ${count} file`,
        ranCommands: ({ count }: { count: number }) => count === 1 ? 'Eseguito 1 comando' : `Eseguiti ${count} comandi`,
        searched: ({ count }: { count: number }) => count === 1 ? 'Cercato 1 volta' : `Cercato ${count} volte`,
        fetchedUrls: ({ count }: { count: number }) => count === 1 ? 'Recuperato 1 URL' : `Recuperati ${count} URL`,
        ranTasks: ({ count }: { count: number }) => count === 1 ? 'Eseguito 1 task' : `Eseguiti ${count} task`,
        usedTools: ({ count }: { count: number }) => count === 1 ? 'Usato 1 strumento' : `Usati ${count} strumenti`,
        workedFor: ({ duration }: { duration: string }) => `Worked ${duration}`,
    },

    tools: {
        fullView: {
            description: 'Descrizione',
            inputParams: 'Parametri di input',
            output: 'Output',
            error: 'Errore',
            completed: 'Strumento completato con successo',
            noOutput: 'Nessun output prodotto',
            running: 'Strumento in esecuzione...',
            rawJsonDevMode: 'JSON grezzo (Modalità sviluppatore)',
        },
        taskView: {
            initializing: 'Inizializzazione agente...',
            moreTools: ({ count }: { count: number }) => `+${count} altri ${plural({ count, singular: 'strumento', plural: 'strumenti' })}`,
        },
        askUserQuestion: {
            submit: 'Invia risposta',
            multipleQuestions: ({ count }: { count: number }) => `${count} ${plural({ count, singular: 'domanda', plural: 'domande' })}`,
            other: 'Altro',
            otherDescription: 'Scrivi la tua risposta',
            otherPlaceholder: 'Scrivi la tua risposta...',
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Modifica ${index} di ${total}`,
            replaceAll: 'Sostituisci tutto',
        },
        names: {
            task: 'Attività',
            terminal: 'Terminale',
            searchFiles: 'Cerca file',
            search: 'Cerca',
            searchContent: 'Cerca contenuto',
            listFiles: 'Elenca file',
            planProposal: 'Proposta di piano',
            readFile: 'Leggi file',
            editFile: 'Modifica file',
            writeFile: 'Scrivi file',
            fetchUrl: 'Recupera URL',
            readNotebook: 'Leggi notebook',
            editNotebook: 'Modifica notebook',
            todoList: 'Elenco attività',
            webSearch: 'Ricerca web',
            reasoning: 'Ragionamento',
            applyChanges: 'Aggiorna file',
            viewDiff: 'Modifiche file attuali',
            question: 'Domanda',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminale(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Cerca(pattern: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Cerca(path: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Recupera URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Modifica notebook(file: ${path}, mode: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Elenco attività(count: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Ricerca web(query: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(pattern: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} modifiche)`,
            readingFile: ({ file }: { file: string }) => `Leggendo ${file}`,
            writingFile: ({ file }: { file: string }) => `Scrivendo ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Modificando ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Modificando ${count} file`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} e altri ${count}`,
            showingDiff: 'Mostrando modifiche',
        }
    },

    files: {
        changes: 'Modifiche',
        searchPlaceholder: 'Cerca file...',
        detachedHead: 'HEAD scollegato',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} in stage • ${unstaged} non in stage`,
        notRepo: 'Non è un repository git',
        notUnderGit: 'Questa directory non è sotto controllo versione git',
        searching: 'Ricerca file...',
        noFilesFound: 'Nessun file trovato',
        noFilesInProject: 'Nessun file nel progetto',
        tryDifferentTerm: 'Prova un termine di ricerca diverso',
        searchResults: ({ count }: { count: number }) => `Risultati ricerca (${count})`,
        projectRoot: 'Radice progetto',
        stagedChanges: ({ count }: { count: number }) => `Modifiche in stage (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Modifiche non in stage (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Caricamento ${fileName}...`,
        binaryFile: 'File binario',
        cannotDisplayBinary: 'Impossibile mostrare il contenuto del file binario',
        diff: 'Diff',
        file: 'File',
        fileEmpty: 'File vuoto',
        noChanges: 'Nessuna modifica da mostrare',
        noChangesTitle: 'Nessuna modifica',
        noChangesSubtitle: 'L\'albero di lavoro è pulito',
        deleted: 'Eliminato',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'file modificato' : 'file modificati'}`,
        allFiles: 'Tutti i file',
        addPanel: 'Aggiungi pannello',
        closePanel: 'Chiudi pannello',
        editFile: 'Modifica',
        saveFile: 'Salva',
        failedToRead: 'Impossibile leggere il file',
        failedToSave: 'Impossibile salvare il file',
        fileConflict: 'Conflitto file',
        fileConflictDescription: 'Questo file è stato modificato sul dispositivo mentre lo stavi modificando. Ricarica per vedere l\'ultima versione.',
        reload: 'Ricarica',
        overwrite: 'Sovrascrivi',
    },
    sideChat: {
        panelTitle: 'Chat laterale',
        emptyTitle: 'Avvia una chat laterale',
        emptySubtitle: 'Chiedi qualcosa all’agente a parte. Eredita il contesto di questa chat ma rimane isolata — nulla qui tocca la conversazione principale.',
        startButton: 'Avvia chat laterale',
        creating: 'Avvio della chat laterale…',
        unavailable: 'Questa sessione non può ancora avviare una chat laterale — attendi che l’agente sia online.',
        composerPlaceholder: 'Messaggio alla chat laterale…',
        expand: 'Apri a schermo intero',
        tabLabel: ({ index }: { index: number }) => `Chat laterale ${index}`,
        newChat: 'Nuova chat laterale',
        close: 'Chiudi chat laterale',
    },



    settingsLanguage: {
        // Language settings screen
        title: 'Lingua',
        description: 'Scegli la tua lingua preferita per l\'interfaccia dell\'app. Questo si sincronizza su tutti i tuoi dispositivi.',
        currentLanguage: 'Lingua attuale',
        automatic: 'Automatico',
        automaticSubtitle: 'Rileva dalle impostazioni del dispositivo',
        needsRestart: 'Lingua cambiata',
        needsRestartMessage: 'L\'app deve riavviarsi per applicare la nuova impostazione della lingua.',
        restartNow: 'Riavvia ora',
    },


    updateBanner: {
        updateAvailable: 'Aggiornamento disponibile',
        pressToApply: 'Premi per applicare l\'aggiornamento',
        whatsNew: 'Novità',
        seeLatest: 'Vedi gli ultimi aggiornamenti e miglioramenti',
        nativeUpdateAvailable: 'Aggiornamento app disponibile',
        tapToUpdateAppStore: 'Tocca per aggiornare nell\'App Store',
        tapToUpdatePlayStore: 'Tocca per aggiornare nel Play Store',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Versione ${version}`,
        noEntriesAvailable: 'Nessuna voce di changelog disponibile.',
    },


    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Autentica terminale',
        pasteUrlFromTerminal: 'Incolla l\'URL di autenticazione dal terminale',
        deviceLinkedSuccessfully: 'Dispositivo collegato con successo',
        terminalConnectedSuccessfully: 'Terminale collegato con successo',
        invalidAuthUrl: 'URL di autenticazione non valido',
        failedToConnectTerminal: 'Impossibile connettere il terminale',
        cameraPermissionsRequiredToConnectTerminal: 'Sono necessarie le autorizzazioni della fotocamera per connettere il terminale',
        failedToLinkDevice: 'Impossibile collegare il dispositivo',
        cameraPermissionsRequiredToScanQr: 'Sono necessarie le autorizzazioni della fotocamera per scansionare i codici QR'
    },

    navigation: {
        // Navigation titles and screen headers
        whatsNew: 'Novità',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Client mobile di Codex e Claude Code',
        subtitle: 'Crittografia end-to-end e account memorizzato solo sul tuo dispositivo.',
        createAccount: 'Crea account',
        linkOrRestoreAccount: 'Collega o ripristina account',
        loginWithMobileApp: 'Accedi con l\'app mobile',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Ti piace l\'app?',
        feedbackPrompt: 'Ci piacerebbe ricevere il tuo feedback!',
        yesILoveIt: 'Sì, mi piace!',
        notReally: 'Non proprio'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copiato negli appunti`
    },

    machine: {
        launchNewSessionInDirectory: 'Avvia nuova sessione nella directory',
        offlineUnableToSpawn: 'Avvio disabilitato quando la macchina è offline',
        offlineHelp: '• Assicurati che il tuo computer sia online\n• Esegui `happy daemon status` per diagnosticare\n• Stai usando l\'ultima versione della CLI? Aggiorna con `npm install -g happy@latest`',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Passato alla modalità ${mode}`,
        unknownEvent: 'Evento sconosciuto',
        usageLimitUntil: ({ time }: { time: string }) => `Limite di utilizzo raggiunto fino a ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: 'ora sconosciuta',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: 'Sì, e non chiedere per una sessione',
            stopAndExplain: 'Fermati e spiega cosa devo fare',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Sì, consenti tutte le modifiche durante questa sessione',
            yesAllowEverything: 'Sì, consenti tutto durante questa sessione',
            yesForTool: 'Sì, non chiedere più per questo strumento',
            noTellClaude: 'No, fornisci feedback',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: 'Seleziona intervallo di testo',
        title: 'Seleziona testo',
        noTextProvided: 'Nessun testo fornito',
        textNotFound: 'Testo non trovato o scaduto',
        textCopied: 'Testo copiato negli appunti',
        failedToCopy: 'Impossibile copiare il testo negli appunti',
        noTextToCopy: 'Nessun testo disponibile da copiare',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Codice copiato',
        copyFailed: 'Copia non riuscita',
        mermaidRenderFailed: 'Impossibile renderizzare il diagramma mermaid',
    },




    imageUpload: {
        permissionTitle: 'Accesso alla libreria foto',
        permissionMessage: "Consenti l'accesso alla tua libreria foto per allegare immagini ai messaggi.",
        limitTitle: 'Limite immagini raggiunto',
        limitMessage: ({ max }: { max: number }) => `Puoi allegare fino a ${max} immagini per messaggio.`,
        fileTooLargeTitle: 'File troppo grande',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" supera il limite di ${maxMb}MB e non è stato aggiunto.`,
        uploadFailedTitle: 'Caricamento non riuscito',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'Un\'immagine non è stata caricata e non è stata inviata.'
            : `Non è stato possibile caricare ${count} immagini e non sono state inviate.`,
        notSupportedTitle: 'Immagini non supportate',
        notSupportedMessage: 'Questo agente non supporta gli allegati immagine. Le immagini non sono state inviate.',
    },

} as const;

export type TranslationsIt = typeof it;
