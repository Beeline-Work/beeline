import type { TranslationStructure } from '../_default';

/**
 * Catalan plural helper function
 * Catalan has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Catalan plural rules
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

/**
 * Catalan translations for the Happy app
 * Must match the exact structure of the English translations
 */
export const ca: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Terminals',
        settings: 'Configuració',
    },


    common: {
        // Simple string constants
        cancel: 'Cancel·la',
        authenticate: 'Autentica',
        save: 'Desa',
        saveAs: 'Desa com a',
        error: 'Error',
        success: 'Èxit',
        ok: 'D\'acord',
        continue: 'Continua',
        back: 'Enrere',
        create: 'Crear',
        rename: 'Reanomena',
        reset: 'Reinicia',
        logout: 'Tanca la sessió',
        yes: 'Sí',
        no: 'No',
        discard: 'Descarta',
        version: 'Versió',
        copied: 'Copiat',
        copy: 'Copiar',
        scanning: 'Escanejant...',
        urlPlaceholder: 'https://exemple.com',
        home: 'Inici',
        message: 'Missatge',
        files: 'Fitxers',
        fileViewer: 'Visualitzador de fitxers',
        loading: 'Carregant...',
        retry: 'Torna-ho a provar',
        delete: 'Elimina',
        optional: 'Opcional',
    },

    profile: {
        userProfile: 'Perfil d\'usuari',
        details: 'Detalls',
        firstName: 'Nom',
        lastName: 'Cognoms',
        username: 'Nom d\'usuari',
        status: 'Estat',
    },


    status: {
        connected: 'connectat',
        connecting: 'connectant',
        disconnected: 'desconnectat',
        error: 'error',
        online: 'en línia',
        offline: 'fora de línia',
        lastSeen: ({ time }: { time: string }) => `vist per última vegada ${time}`,
        permissionRequired: 'permís requerit',
        activeNow: 'Actiu ara',
        unknown: 'desconegut',
        unread: 'nous resultats',
    },

    time: {
        justNow: 'ara mateix',
        minutesAgo: ({ count }: { count: number }) => `fa ${count} minut${count !== 1 ? 's' : ''}`,
        hoursAgo: ({ count }: { count: number }) => `fa ${count} hora${count !== 1 ? 'es' : ''}`,
        daysAgo: ({ count }: { count: number }) => `fa ${count} dia${count !== 1 ? 's' : ''}`,
    },

    connect: {
        enterUrlManually: 'Introdueix l\'URL manualment',
    },

    settings: {
        title: 'Configuració',
        github: 'GitHub',
        features: 'Funcions',
        appearance: 'Aparença',
        appearanceSubtitle: 'Personalitza l\'aspecte de l\'aplicació',
        featuresTitle: 'Funcions',
        featuresSubtitle: 'Activa o desactiva les funcions de l\'aplicació',
        about: 'Quant a',
        aboutFooter: 'Happy Coder és un client mòbil de Codex i Claude Code. Tot està xifrat punt a punt i el teu compte es guarda només al teu dispositiu. No està afiliat amb Anthropic.',
        whatsNew: 'Novetats',
        whatsNewSubtitle: 'Mira les últimes actualitzacions i millores',
        reportIssue: 'Informa d\'un problema',
        privacyPolicy: 'Política de privadesa',
        termsOfService: 'Condicions del servei',
        eula: 'EULA',
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'activada' : 'desactivada'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Tema',
        themeDescription: 'Tria el teu esquema de colors preferit',
        themeOptions: {
            adaptive: 'Adaptatiu',
            light: 'Clar', 
            dark: 'Fosc',
        },
        themeDescriptions: {
            adaptive: 'Segueix la configuració del sistema',
            light: 'Usa sempre el tema clar',
            dark: 'Usa sempre el tema fosc',
        },
        chat: 'Xat',
        chatDescription: 'Personalitza l\'aspecte dels missatges del xat',
        sessionStatusBar: 'Informació d\'estat de la sessió',
        sessionStatusBarDescription: 'Tria on es mostren la branca, el model, l\'esforç i el context',
        sessionStatusDisplayOptions: {
            hidden: 'Ocult',
            above: 'Sobre el compositor',
            below: 'Sota el compositor',
        },
        usageLimitShowRemaining: 'Mostra la quota restant',
        usageLimitShowRemainingDescription: 'Els indicadors de límit compten enrere en lloc d\'endavant',
        userMessageBubbleColor: 'Color dels teus missatges',
        userMessageBubbleColorDescription: 'Fes que els teus missatges siguin més fàcils de trobar en xats llargs',
        userMessageBubbleColorOptions: {
            blue: 'Blau',
            green: 'Verd',
            purple: 'Porpra',
            rose: 'Rosa',
            sand: 'Sorra',
            gray: 'Gris',
        },
        display: 'Pantalla',
        displayDescription: 'Controla la disposició i l\'espaiat',
        compactToolCalls: 'Crides d\'eines compactes',
        compactToolCallsDescription: 'Mostra les crides no interactives en una sola línia; obre una fila per veure\'n els detalls',
        inlineToolCalls: 'Crides d\'eines en línia',
        inlineToolCallsDescription: 'Mostra les crides d\'eines directament als missatges de xat',
        expandTodoLists: 'Expandeix les llistes de tasques',
        expandTodoListsDescription: 'Mostra totes les tasques en lloc de només els canvis',
        showLineNumbersInDiffs: 'Mostra els números de línia a les diferències',
        showLineNumbersInDiffsDescription: 'Mostra els números de línia a les diferències de codi',
        showLineNumbersInToolViews: 'Mostra els números de línia a les vistes d\'eines',
        showLineNumbersInToolViewsDescription: 'Mostra els números de línia a les diferències de vistes d\'eines',
        wrapLinesInDiffs: 'Ajusta les línies a les diferències',
        wrapLinesInDiffsDescription: 'Ajusta les línies llargues en lloc de desplaçament horitzontal a les vistes de diferències',
        diffStyle: 'Vista de diferències',
        diffStyleDescription: 'Mostra les diferències en una sola columna (unified) o una al costat de l\'altra (split). La vista split només funciona al web.',
        diffStyleOptions: {
            unified: 'Unified',
            split: 'Split',
        },
        alwaysShowContextSize: 'Mostra sempre la mida del context',
        alwaysShowContextSizeDescription: 'Mostra l\'ús del context fins i tot quan no estigui prop del límit',
        avatarStyle: 'Estil d\'avatar',
        avatarStyleDescription: 'Tria l\'aparença de l\'avatar de la sessió',
        avatarOptions: {
            pixelated: 'Pixelat',
            gradient: 'Gradient',
            brutalist: 'Brutalista',
        },
        showFlavorIcons: "Mostrar icones de proveïdors d'IA",
        showFlavorIconsDescription: "Mostrar icones del proveïdor d'IA als avatars de sessió",
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Experiments',
        experimentsDescription: 'Activa funcions experimentals que encara estan en desenvolupament. Aquestes funcions poden ser inestables o canviar sense avís.',
        experimentalFeatures: 'Funcions experimentals',
        experimentalFeaturesEnabled: 'Funcions experimentals activades',
        experimentalFeaturesDisabled: 'Utilitzant només funcions estables',
        webFeatures: 'Funcions web',
        webFeaturesDescription: 'Funcions disponibles només a la versió web de l\'app.',
        enterToSend: 'Enter per enviar',
        enterToSendEnabled: 'Prem Enter per enviar (Maj+Enter per a una nova línia)',
        enterToSendDisabled: 'Enter insereix una nova línia',
        commandPalette: 'Paleta de comandes',
        commandPaletteEnabled: 'Prem ⌘K per obrir',
        commandPaletteDisabled: 'Accés ràpid a comandes desactivat',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Pulsació llarga obre modal de còpia',
        hideInactiveSessions: 'Amaga les sessions inactives',
        hideInactiveSessionsSubtitle: 'Mostra només els xats actius a la llista',
        groupToolCalls: 'Agrupa les crides a eines',
        groupToolCallsSubtitle: 'Replega les crides consecutives a eines en un sol contenidor',
        privacy: 'Privadesa',
        privacyDescription: 'Desactiva completament tota l\'analítica i telemetria. No s\'enviaran dades a PostHog ni a cap altre servei de seguiment.',
        disableAnalytics: 'Desactivar analítica',
        analyticsDisabled: 'Tot el seguiment i telemetria desactivats',
        analyticsEnabled: 'Analítica anònima d\'ús activa',
        imageUpload: 'Pujada d\'imatges',
        imageUploadSubtitle: 'Adjunta imatges als missatges perquè els agents compatibles les analitzin',
    },

    errors: {
        networkError: 'Error de connexió',
        serverError: 'Error del servidor',
        unknownError: 'Error desconegut',
        connectionTimeout: 'S\'ha esgotat el temps de connexió',
        authenticationFailed: 'L\'autenticació ha fallat',
        permissionDenied: 'Permís denegat',
        fileNotFound: 'Fitxer no trobat',
        invalidFormat: 'Format no vàlid',
        operationFailed: 'L\'operació ha fallat',
        tryAgain: 'Torna-ho a provar',
        contactSupport: 'Contacta amb el suport si el problema persisteix',
        sessionNotFound: 'Sessió no trobada',
        voiceSessionFailed: 'Ha fallat l\'inici de la sessió de veu',
        voiceServiceUnavailable: 'El servei de veu no està disponible temporalment',
        voiceLimitReachedTitle: 'Límit de veu assolit',
        voiceHardLimitReached: ({ hours }: { hours: number }) => `Has utilitzat ${hours}+ hores de veu aquest mes. Aquest és el màxim permès. Pots configurar el teu propi agent ElevenLabs a la configuració de veu per utilitzar la teva pròpia quota.`,
        voiceConversationLimitReached: 'Has assolit el nombre màxim de converses de veu aquest mes. És possible que en el futur afegim ús de veu sota demanda — si us plau, crea un issue a github.com/nicepkg/happy/issues si arribes a aquest límit.',
        oauthInitializationFailed: 'Ha fallat la inicialització del flux OAuth',
        tokenStorageFailed: 'Ha fallat l\'emmagatzematge dels tokens d\'autenticació',
        oauthStateMismatch: 'Ha fallat la validació de seguretat. Si us plau, torna-ho a provar',
        tokenExchangeFailed: 'Ha fallat l\'intercanvi del codi d\'autorització',
        oauthAuthorizationDenied: 'L\'autorització ha estat denegada',
        webViewLoadFailed: 'Ha fallat la càrrega de la pàgina d\'autenticació',
        failedToLoadProfile: 'No s\'ha pogut carregar el perfil d\'usuari',
        userNotFound: 'Usuari no trobat',
        sessionDeleted: 'La sessió s\'ha eliminat',
        sessionDeletedDescription: 'Aquesta sessió s\'ha eliminat permanentment',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} ha d'estar entre ${min} i ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Torna-ho a provar en ${seconds} ${seconds === 1 ? 'segon' : 'segons'}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Error ${code})`,
    },

    newSession: {
        title: 'Iniciar nova sessió',
        machineOffline: 'La màquina està fora de línia',
        switchMachinesHint: '• Canvia de màquina fent clic a la màquina de dalt',
    },

    sessionHistory: {
        // Used by session history screen
        empty: 'No s\'han trobat sessions',
        daysAgo: ({ count }: { count: number }) => `fa ${count} ${count === 1 ? 'dia' : 'dies'}`,
    },

    session: {
        inputPlaceholder: 'Escriu un missatge...',
        inactiveArchived: 'Aquesta sessió està inactiva.',
        resumeFromTerminal: 'Per reprendre-la des del terminal:',
        newChat: 'Nou xat',
        statusBarContext: 'Context',
        statusBarPathTitle: 'Directori de treball',
        forkAction: 'Bifurca la sessió',
        forkSubtitle: 'Continua en una nova sessió amb el mateix context',
        duplicateAction: 'Duplica des d\'un missatge…',
        duplicateSubtitle: 'Torna a un punt escollit i prova de nou',
        forkFromHere: 'Bifurca des d\'aquí',
        duplicateSheetTitle: 'Tria un punt de retrocés',
        duplicateSheetSubtitle: 'La nova sessió conservarà el torn escollit complet (el teu missatge i la resposta de l\'agent) i descartarà els missatges següents.',
        duplicateSheetConfirm: 'Duplica',
        duplicateSheetEmpty: 'Encara no hi ha missatges per retrocedir en aquesta sessió.',
        duplicateRowDisabled: 'Aquest missatge no es pot usar com a punt de retrocés.',
        forkedFromLabel: 'Bifurcat de',
        forkedFromSubtitle: 'Obre la sessió de la qual prové la bifurcació',
        forkErrorOffline: 'La màquina està fora de línia. La bifurcació només està disponible mentre la màquina de la sessió estigui en línia.',
        forkErrorMissingUuid: 'El punt de retrocés escollit ja no existeix a la sessió origen — prova a bifurcar sense truncar.',
        forkErrorMissingMetadata: 'Falten metadades de la sessió necessàries per bifurcar.',
        forkErrorGeneric: 'No s\'ha pogut bifurcar la sessió.',
        forkClaudeOnly: 'La bifurcació només està disponible per a sessions de Claude.',
    },

    commandPalette: {
        placeholder: 'Escriu una comanda o cerca...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Finalitza la sessió',
        killSessionConfirm: 'Segur que vols finalitzar aquesta sessió?',
        archiveSession: 'Arxiva la sessió',
        archiveSessionConfirm: 'Segur que vols arxivar aquesta sessió?',
        happySessionIdCopied: 'ID de la sessió de Happy copiat al porta-retalls',
        failedToCopySessionId: 'Ha fallat copiar l\'ID de la sessió de Happy',
        happySessionId: 'ID de la sessió de Happy',
        claudeCodeSessionId: 'ID de la sessió de Claude Code',
        claudeCodeSessionIdCopied: 'ID de la sessió de Claude Code copiat al porta-retalls',
        codexThreadId: 'ID del fil de Codex',
        codexThreadIdCopied: 'ID del fil de Codex copiat al porta-retalls',
        aiProvider: 'Proveïdor d\'IA',
        failedToCopyClaudeCodeSessionId: 'Ha fallat copiar l\'ID de la sessió de Claude Code',
        failedToCopyCodexThreadId: 'Ha fallat copiar l\'ID del fil de Codex',
        metadataCopied: 'Metadades copiades al porta-retalls',
        failedToCopyMetadata: 'Ha fallat copiar les metadades',
        failedToKillSession: 'Ha fallat finalitzar la sessió',
        failedToArchiveSession: 'Ha fallat arxivar la sessió',
        connectionStatus: 'Estat de la connexió',
        created: 'Creat',
        lastUpdated: 'Última actualització',
        sequence: 'Seqüència',
        quickActions: 'Accions ràpides',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionNeedsHappyAgent: 'Resume is unavailable on this machine. Run `happy-agent auth login` to enable it.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Claude or Codex identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        killSessionSubtitle: 'Finalitzar immediatament la sessió',
        archiveSessionSubtitle: 'Arxiva aquesta sessió i atura-la',
        metadata: 'Metadades',
        host: 'Host',
        path: 'Camí',
        operatingSystem: 'Sistema operatiu',
        processId: 'ID del procés',
        happyHome: 'Directori de Happy',
        copyMetadata: 'Copia les metadades',
        agentState: 'Estat de l\'agent',
        controlledByUser: 'Controlat per l\'usuari',
        pendingRequests: 'Sol·licituds pendents',
        activity: 'Activitat',
        thinking: 'Pensant',
        thinkingSince: 'Pensant des de',
        cliVersion: 'Versió del CLI',
        cliVersionOutdated: 'Actualització del CLI requerida',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Versió ${currentVersion} instal·lada. Actualitzeu a ${requiredVersion} o posterior`,
        updateCliInstructions: 'Si us plau executeu npm install -g happy@latest',
        deleteSession: 'Elimina la sessió',
        deleteSessionSubtitle: 'Elimina permanentment aquesta sessió',
        deleteSessionConfirm: 'Eliminar la sessió permanentment?',
        deleteSessionWarning: 'Aquesta acció no es pot desfer. Tots els missatges i dades associats amb aquesta sessió s\'eliminaran permanentment.',
        failedToDeleteSession: 'Error en eliminar la sessió',
        sessionDeleted: 'Sessió eliminada amb èxit',
        worktreeCleanupTitle: 'Eliminar Worktree?',
        worktreeCleanupMessage: 'El Worktree no té canvis sense confirmar. Vols eliminar els fitxers del Worktree?',
        worktreeCleanupDelete: 'Eliminar Worktree',
        worktreeCleanupKeep: 'Conservar fitxers',

    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Llest per programar?',
            installCli: 'Instal·la el Happy CLI',
            runIt: 'Executa\'l',
            scanQrCode: 'Escaneja el codi QR',
            openCamera: 'Obre la càmera',
        },
        agentGoalBar: {
            currentGoal: 'Objectiu actual',
            accessibilityLabel: ({ goal }: { goal: string }) => `Objectiu actual: ${goal}`,
            clearGoal: 'Esborra objectiu',
            stopGoal: 'Atura objectiu',
            editGoal: 'Edita objectiu',
        },
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Context ${used} de ${total} tokens, ${percent}%`,
            limitFiveHour: 'Límit de 5 hores',
            limitSevenDay: 'Límit de 7 dies',
            limitResets: ({ time }: { time: string }) => `es restableix ${time}`,
            limitAsOf: ({ age }: { age: string }) => `fa ${age}`,
            limitRemaining: ({ percent }: { percent: number }) => `${percent}% restant`,
        },
    },

    agentInput: {
        permissionMode: {
            title: 'MODE DE PERMISOS',
            default: 'Per defecte',
            acceptEdits: 'Accepta edicions',
            plan: 'Mode de planificació',
            dontAsk: 'No preguntis',
            bypassPermissions: 'Mode Yolo',
            badgeAcceptAllEdits: 'Accepta totes les edicions',
            badgeBypassAllPermissions: 'Omet tots els permisos',
            badgePlanMode: 'Mode de planificació',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
            openclaw: 'OpenClaw',
        },
        model: {
            title: 'MODEL',
            configureInCli: 'Configura els models a la configuració del CLI',
        },
        effort: {
            title: 'ESFORÇ',
        },
        codexPermissionMode: {
            title: 'MODE DE PERMISOS CODEX',
            default: 'Configuració del CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            defaultDescription: "pregunta abans d'ordres no fiables",
            readOnlyDescription: 'sense escriptura',
            safeYoloDescription: "sense preguntes, sandbox de l'espai de treball",
            yoloDescription: 'sense preguntes, accés complet',
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
            title: 'MODE DE PERMISOS GEMINI',
            default: 'Per defecte',
            autoEdit: 'Edició automàtica',
            yolo: 'YOLO',
            plan: 'Planificació',
            badgeAutoEdit: 'Edició automàtica',
            badgeYolo: 'YOLO',
            badgePlan: 'Planificació',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% restant`,
        },
        suggestion: {
            fileLabel: 'FITXER',
            folderLabel: 'CARPETA',
        },
        noMachinesAvailable: 'Sense màquines',
    },

    machineLauncher: {
        showLess: 'Mostra menys',
        showAll: ({ count }: { count: number }) => `Mostra tots (${count} camins)`,
        enterCustomPath: 'Introdueix un camí personalitzat',
        offlineUnableToSpawn: 'No es pot crear una nova sessió, fora de línia',
    },

    agentQuestion: {
        title: "Pregunta",
        submit: "Envia la resposta",
        chooseMultiple: "Tria totes les que apliquin",
        ownAnswer: "La teva pròpia resposta",
        ownAnswerPlaceholder: "Escriu una resposta",
        submitFailed: "No s'ha pogut enviar la resposta",
        dismiss: "Descarta",
        unsupportedTitle: "Sol·licitud no compatible",
        unsupportedDescription: ({ kind }: { kind: string }) => `Aquesta versió de Happy no pot mostrar una sol·licitud «${kind}». Actualitza l'app per respondre.`,
        moreQuestions: ({ count }: { count: number }) =>
            count === 1 ? "1 pregunta més" : `${count} preguntes més`,
    },

    sidebar: {
        sessionsTitle: 'Happy',
        showArchived: 'Mostra arxivades',
        hideArchived: 'Amaga arxivades',
        newSession: 'Nova sessió',
        projects: "Projectes",
    },

    zen: {
        toggle: 'Mode zen',
    },

    toolView: {
        input: 'Entrada',
        output: 'Sortida',
    },

    toolGroup: {
        editedFile: 'Edited file',
        editedFiles: ({ count }: { count: number }) => count === 1 ? 'S\'ha editat 1 fitxer' : `S'han editat ${count} fitxers`,
        readFiles: ({ count }: { count: number }) => count === 1 ? 'S\'ha llegit 1 fitxer' : `S'han llegit ${count} fitxers`,
        ranCommands: ({ count }: { count: number }) => count === 1 ? 'S\'ha executat 1 comanda' : `S'han executat ${count} comandes`,
        searched: ({ count }: { count: number }) => count === 1 ? 'S\'ha cercat 1 vegada' : `S'ha cercat ${count} vegades`,
        fetchedUrls: ({ count }: { count: number }) => count === 1 ? 'S\'ha obtingut 1 URL' : `S'han obtingut ${count} URLs`,
        ranTasks: ({ count }: { count: number }) => count === 1 ? 'S\'ha executat 1 tasca' : `S'han executat ${count} tasques`,
        usedTools: ({ count }: { count: number }) => count === 1 ? 'S\'ha usat 1 eina' : `S'han usat ${count} eines`,
        workedFor: ({ duration }: { duration: string }) => `Worked ${duration}`,
    },

    tools: {
        fullView: {
            description: 'Descripció',
            inputParams: 'Paràmetres d\'entrada',
            output: 'Sortida',
            error: 'Error',
            completed: 'Eina completada amb èxit',
            noOutput: 'No s\'ha produït cap sortida',
            running: 'L\'eina s\'està executant...',
            rawJsonDevMode: 'JSON en brut (mode desenvolupador)',
        },
        taskView: {
            initializing: 'Inicialitzant l\'agent...',
            moreTools: ({ count }: { count: number }) => `+${count} més ${plural({ count, singular: 'eina', plural: 'eines' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Edició ${index} de ${total}`,
            replaceAll: 'Reemplaça tot',
        },
        names: {
            task: 'Tasca',
            terminal: 'Terminal',
            searchFiles: 'Cerca fitxers',
            search: 'Cerca',
            searchContent: 'Cerca contingut',
            listFiles: 'Llista fitxers',
            planProposal: 'Proposta de pla',
            readFile: 'Llegeix fitxer',
            editFile: 'Edita fitxer',
            writeFile: 'Escriu fitxer',
            fetchUrl: 'Obté URL',
            readNotebook: 'Llegeix quadern',
            editNotebook: 'Edita quadern',
            todoList: 'Llista de tasques',
            webSearch: 'Cerca web',
            reasoning: 'Raonament',
            applyChanges: 'Actualitza fitxer',
            viewDiff: 'Canvis del fitxer actual',
            question: 'Pregunta',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Cerca(patró: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Cerca(camí: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Obté URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Edita quadern(fitxer: ${path}, mode: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Llista de tasques(quantitat: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Cerca web(consulta: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(patró: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} edicions)`,
            readingFile: ({ file }: { file: string }) => `Llegint ${file}`,
            writingFile: ({ file }: { file: string }) => `Escrivint ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Modificant ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Modificant ${count} fitxers`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} i ${count} més`,
            showingDiff: 'Mostrant canvis',
        },
        askUserQuestion: {
            submit: 'Envia resposta',
            multipleQuestions: ({ count }: { count: number }) => `${count} ${plural({ count, singular: 'pregunta', plural: 'preguntes' })}`,
            other: 'Altres',
            otherDescription: 'Escriu la teva pròpia resposta',
            otherPlaceholder: 'Escriu la teva resposta...',
        }
    },

    files: {
        changes: 'Canvis',
        searchPlaceholder: 'Cerca fitxers...',
        detachedHead: 'HEAD separat',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} preparats • ${unstaged} sense preparar`,
        notRepo: 'No és un repositori git',
        notUnderGit: 'Aquest directori no està sota control de versions git',
        searching: 'Cercant fitxers...',
        noFilesFound: 'No s\'han trobat fitxers',
        noFilesInProject: 'No hi ha fitxers al projecte',
        tryDifferentTerm: 'Prova un terme de cerca diferent',
        searchResults: ({ count }: { count: number }) => `Resultats de la cerca (${count})`,
        projectRoot: 'Arrel del projecte',
        stagedChanges: ({ count }: { count: number }) => `Canvis preparats (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Canvis sense preparar (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Carregant ${fileName}...`,
        binaryFile: 'Fitxer binari',
        cannotDisplayBinary: 'No es pot mostrar el contingut del fitxer binari',
        diff: 'Diferències',
        file: 'Fitxer',
        fileEmpty: 'El fitxer està buit',
        noChanges: 'No hi ha canvis a mostrar',
        noChangesTitle: 'Sense canvis',
        noChangesSubtitle: 'L\'arbre de treball està net',
        deleted: 'Eliminat',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'fitxer modificat' : 'fitxers modificats'}`,
        allFiles: 'Tots els fitxers',
        addPanel: 'Afegeix un panell',
        closePanel: 'Tanca el panell',
        editFile: 'Editar',
        saveFile: 'Desar',
        failedToRead: 'No s\'ha pogut llegir el fitxer',
        failedToSave: 'No s\'ha pogut desar el fitxer',
        fileConflict: 'Conflicte de fitxer',
        fileConflictDescription: 'Aquest fitxer s\'ha modificat al dispositiu mentre l\'editaves. Recarrega per veure la darrera versió.',
        reload: 'Recarregar',
        overwrite: 'Sobreescriure',
    },
    sideChat: {
        panelTitle: 'Xat lateral',
        emptyTitle: 'Inicia un xat lateral',
        emptySubtitle: 'Pregunta alguna cosa a l’agent a part. Hereta el context d’aquest xat però es manté aïllat — res d’aquí no afecta la conversa principal.',
        startButton: 'Inicia el xat lateral',
        creating: 'Iniciant el xat lateral…',
        unavailable: 'Aquesta sessió encara no pot iniciar un xat lateral — espera que l’agent estigui en línia.',
        composerPlaceholder: 'Missatge al xat lateral…',
        expand: 'Obre a pantalla completa',
        tabLabel: ({ index }: { index: number }) => `Xat lateral ${index}`,
        newChat: 'Nou xat lateral',
        close: 'Tanca el xat lateral',
    },



    settingsLanguage: {
        // Language settings screen
        title: 'Idioma',
        description: 'Tria el teu idioma preferit per a la interfície de l\'app. Això se sincronitzarà a tots els teus dispositius.',
        currentLanguage: 'Idioma actual',
        automatic: 'Automàtic',
        automaticSubtitle: 'Detecta des de la configuració del dispositiu',
        needsRestart: 'Idioma canviat',
        needsRestartMessage: 'L\'aplicació necessita reiniciar-se per aplicar la nova configuració d\'idioma.',
        restartNow: 'Reinicia ara',
    },


    updateBanner: {
        updateAvailable: 'Actualització disponible',
        pressToApply: 'Prem per aplicar l\'actualització',
        whatsNew: 'Novetats',
        seeLatest: 'Mira les últimes actualitzacions i millores',
        nativeUpdateAvailable: 'Actualització de l\'aplicació disponible',
        tapToUpdateAppStore: 'Toca per actualitzar a l\'App Store',
        tapToUpdatePlayStore: 'Toca per actualitzar a Play Store',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Versió ${version}`,
        noEntriesAvailable: 'No hi ha entrades de registre de canvis disponibles.',
    },


    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Autentica el terminal',
        pasteUrlFromTerminal: 'Enganxa l\'URL d\'autenticació del teu terminal',
        deviceLinkedSuccessfully: 'Dispositiu enllaçat amb èxit',
        terminalConnectedSuccessfully: 'Terminal connectat amb èxit',
        invalidAuthUrl: 'URL d\'autenticació no vàlida',
        failedToConnectTerminal: 'Ha fallat connectar el terminal',
        cameraPermissionsRequiredToConnectTerminal: 'Es requereixen permisos de càmera per connectar el terminal',
        failedToLinkDevice: 'Ha fallat enllaçar el dispositiu',
        cameraPermissionsRequiredToScanQr: 'Es requereixen permisos de càmera per escanejar codis QR'
    },

    navigation: {
        // Navigation titles and screen headers
        whatsNew: 'Novetats',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Client mòbil de Codex i Claude Code',
        subtitle: 'Xifrat punt a punt i el teu compte s\'emmagatzema només al teu dispositiu.',
        createAccount: 'Crea un compte',
        linkOrRestoreAccount: 'Enllaça o restaura un compte',
        loginWithMobileApp: 'Inicia sessió amb l\'aplicació mòbil',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'T\'està agradant l\'aplicació?',
        feedbackPrompt: 'Ens encantaria conèixer la teva opinió!',
        yesILoveIt: 'Sí, m\'encanta!',
        notReally: 'No gaire'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copiat al porta-retalls`
    },

    machine: {
        offlineUnableToSpawn: 'El llançador està desactivat mentre la màquina està fora de línia',
        offlineHelp: '• Assegura\'t que l\'ordinador estigui en línia\n• Executa `happy daemon status` per diagnosticar\n• Fas servir l\'última versió del CLI? Actualitza amb `npm install -g happy@latest`',
        launchNewSessionInDirectory: 'Inicia una nova sessió al directori',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `S'ha canviat al mode ${mode}`,
        unknownEvent: 'Esdeveniment desconegut',
        usageLimitUntil: ({ time }: { time: string }) => `Límit d'ús assolit fins a ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: 'temps desconegut',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: 'Sí, i no preguntar per aquesta sessió',
            stopAndExplain: 'Atura, i explica què fer',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Sí, permet totes les edicions durant aquesta sessió',
            yesAllowEverything: 'Sí, permet-ho tot durant aquesta sessió',
            yesForTool: 'Sí, no tornis a preguntar per aquesta eina',
            noTellClaude: 'No, proporciona comentaris',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: 'Seleccionar rang de text',
        title: 'Seleccionar text',
        noTextProvided: 'No s\'ha proporcionat text',
        textNotFound: 'Text no trobat o expirat',
        textCopied: 'Text copiat al porta-retalls',
        failedToCopy: 'No s\'ha pogut copiar el text al porta-retalls',
        noTextToCopy: 'No hi ha text disponible per copiar',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Codi copiat',
        copyFailed: 'Error al copiar',
        mermaidRenderFailed: 'Error al renderitzar el diagrama mermaid',
    },




    imageUpload: {
        permissionTitle: 'Accés a la biblioteca de fotos',
        permissionMessage: "Permet l'accés a la teva biblioteca de fotos per adjuntar imatges als missatges.",
        limitTitle: "Límit d'imatges assolit",
        limitMessage: ({ max }: { max: number }) => `Pots adjuntar fins a ${max} imatges per missatge.`,
        fileTooLargeTitle: 'Fitxer massa gran',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" supera el límit de ${maxMb}MB i no s'ha afegit.`,
        uploadFailedTitle: 'Error en la càrrega',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'No s\'ha pogut pujar una imatge i no s\'ha enviat.'
            : `No s'han pogut pujar ${count} imatges i no s'han enviat.`,
        notSupportedTitle: 'Imatges no compatibles',
        notSupportedMessage: 'Aquest agent no admet fitxers adjunts d\'imatge. Les imatges no s\'han enviat.',
    },

} as const;

export type TranslationsCa = typeof ca;
