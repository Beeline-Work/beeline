import type { TranslationStructure } from '../_default';

/**
 * Portuguese plural helper function
 * Portuguese (Brazilian) has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Portuguese plural rules
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

/**
 * Portuguese (Brazilian) translations for the Happy app
 * Must match the exact structure of the English translations
 */
export const pt: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Terminais',
        settings: 'Configurações',
    },


    common: {
        // Simple string constants
        cancel: 'Cancelar',
        authenticate: 'Autenticar',
        save: 'Salvar',
        saveAs: 'Salvar como',
        error: 'Erro',
        success: 'Sucesso',
        ok: 'OK',
        continue: 'Continuar',
        back: 'Voltar',
        create: 'Criar',
        rename: 'Renomear',
        reset: 'Redefinir',
        logout: 'Sair',
        yes: 'Sim',
        no: 'Não',
        discard: 'Descartar',
        version: 'Versão',
        copied: 'Copiado',
        copy: 'Copiar',
        scanning: 'Escaneando...',
        urlPlaceholder: 'https://exemplo.com',
        home: 'Início',
        message: 'Mensagem',
        files: 'Arquivos',
        fileViewer: 'Visualizador de arquivos',
        loading: 'Carregando...',
        retry: 'Tentar novamente',
        delete: 'Excluir',
        optional: 'Opcional',
    },

    profile: {
        userProfile: 'Perfil do usuário',
        details: 'Detalhes',
        firstName: 'Nome',
        lastName: 'Sobrenome',
        username: 'Nome de usuário',
        status: 'Status',
    },


    status: {
        connected: 'conectado',
        connecting: 'conectando',
        disconnected: 'desconectado',
        error: 'erro',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `visto por último ${time}`,
        permissionRequired: 'permissão necessária',
        activeNow: 'Ativo agora',
        unknown: 'desconhecido',
        unread: 'novos resultados',
    },

    time: {
        justNow: 'agora mesmo',
        minutesAgo: ({ count }: { count: number }) => `há ${count} minuto${count !== 1 ? 's' : ''}`,
        hoursAgo: ({ count }: { count: number }) => `há ${count} hora${count !== 1 ? 's' : ''}`,
        daysAgo: ({ count }: { count: number }) => `há ${count} dia${count !== 1 ? 's' : ''}`,
    },

    connect: {
        enterUrlManually: 'Inserir URL manualmente',
    },

    settings: {
        title: 'Configurações',
        github: 'GitHub',
        features: 'Recursos',
        appearance: 'Aparência',
        appearanceSubtitle: 'Personalize a aparência do aplicativo',
        featuresTitle: 'Recursos',
        featuresSubtitle: 'Ativar ou desativar recursos do aplicativo',
        about: 'Sobre',
        aboutFooter: 'Happy Coder é um cliente móvel para Codex e Claude Code. É totalmente criptografado ponta a ponta e sua conta é armazenada apenas no seu dispositivo. Não é afiliado à Anthropic.',
        whatsNew: 'Novidades',
        whatsNewSubtitle: 'Veja as atualizações e melhorias mais recentes',
        reportIssue: 'Relatar um problema',
        privacyPolicy: 'Política de privacidade',
        termsOfService: 'Termos de serviço',
        eula: 'EULA',
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'ativado' : 'desativado'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Tema',
        themeDescription: 'Escolha seu esquema de cores preferido',
        themeOptions: {
            adaptive: 'Adaptativo',
            light: 'Claro', 
            dark: 'Escuro',
        },
        themeDescriptions: {
            adaptive: 'Usar configurações do sistema',
            light: 'Sempre usar tema claro',
            dark: 'Sempre usar tema escuro',
        },
        chat: 'Chat',
        chatDescription: 'Personalize a aparência das mensagens do chat',
        sessionStatusBar: 'Informações de status da sessão',
        sessionStatusBarDescription: 'Escolha onde a branch, o modelo, o esforço e o contexto aparecem',
        sessionStatusDisplayOptions: {
            hidden: 'Oculto',
            above: 'Acima do compositor',
            below: 'Abaixo do compositor',
        },
        usageLimitShowRemaining: 'Mostrar cota restante',
        usageLimitShowRemainingDescription: 'Os indicadores de limite contam para baixo em vez de para cima',
        userMessageBubbleColor: 'Cor das suas mensagens',
        userMessageBubbleColorDescription: 'Torne suas mensagens mais fáceis de encontrar em chats longos',
        userMessageBubbleColorOptions: {
            blue: 'Azul',
            green: 'Verde',
            purple: 'Roxo',
            rose: 'Rosa',
            sand: 'Areia',
            gray: 'Cinza',
        },
        display: 'Exibição',
        displayDescription: 'Controle layout e espaçamento',
        compactToolCalls: 'Chamadas de ferramentas compactas',
        compactToolCallsDescription: 'Mostre chamadas não interativas em uma linha; abra a linha para ver detalhes',
        inlineToolCalls: 'Chamadas de ferramentas inline',
        inlineToolCallsDescription: 'Exibir chamadas de ferramentas diretamente nas mensagens do chat',
        expandTodoLists: 'Expandir listas de tarefas',
        expandTodoListsDescription: 'Mostrar todas as tarefas em vez de apenas as mudanças',
        showLineNumbersInDiffs: 'Mostrar números de linha nos diffs',
        showLineNumbersInDiffsDescription: 'Exibir números de linha nos diffs de código',
        showLineNumbersInToolViews: 'Mostrar números de linha nas visualizações de ferramentas',
        showLineNumbersInToolViewsDescription: 'Exibir números de linha nos diffs das visualizações de ferramentas',
        wrapLinesInDiffs: 'Quebrar linhas nos diffs',
        wrapLinesInDiffsDescription: 'Quebrar linhas longas ao invés de rolagem horizontal nas visualizações de diffs',
        diffStyle: 'Visualização do diff',
        diffStyleDescription: 'Mostrar diffs em uma única coluna (unified) ou lado a lado (split). A visualização split funciona apenas na web.',
        diffStyleOptions: {
            unified: 'Unified',
            split: 'Split',
        },
        alwaysShowContextSize: 'Sempre mostrar tamanho do contexto',
        alwaysShowContextSizeDescription: 'Exibir uso do contexto mesmo quando não estiver próximo do limite',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Experimentos',
        experimentsDescription: 'Ative recursos experimentais que ainda estão em desenvolvimento. Estes recursos podem ser instáveis ou mudar sem aviso.',
        experimentalFeatures: 'Recursos experimentais',
        experimentalFeaturesEnabled: 'Recursos experimentais ativados',
        experimentalFeaturesDisabled: 'Usando apenas recursos estáveis',
        webFeatures: 'Recursos web',
        webFeaturesDescription: 'Recursos disponíveis apenas na versão web do aplicativo.',
        enterToSend: 'Enter para enviar',
        enterToSendEnabled: 'Pressione Enter para enviar (Shift+Enter para nova linha)',
        enterToSendDisabled: 'Enter insere uma nova linha',
        commandPalette: 'Paleta de comandos',
        commandPaletteEnabled: 'Pressione ⌘K para abrir',
        commandPaletteDisabled: 'Acesso rápido a comandos desativado',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Pressione e segure para abrir modal de cópia',
        hideInactiveSessions: 'Ocultar sessões inativas',
        hideInactiveSessionsSubtitle: 'Mostre apenas os chats ativos na sua lista',
        groupToolCalls: 'Agrupar chamadas de ferramentas',
        groupToolCallsSubtitle: 'Recolher chamadas consecutivas de ferramentas em um único contêiner',
        privacy: 'Privacidade',
        privacyDescription: 'Desativa completamente toda a análise e telemetria. Nenhum dado será enviado ao PostHog ou qualquer outro serviço de rastreamento.',
        disableAnalytics: 'Desativar análises',
        analyticsDisabled: 'Todo rastreamento e telemetria desativados',
        analyticsEnabled: 'Análises anônimas de uso ativas',
        imageUpload: 'Upload de imagens',
        imageUploadSubtitle: 'Anexe imagens às mensagens para que agentes compatíveis as analisem',
    },

    errors: {
        networkError: 'Ocorreu um erro de rede',
        serverError: 'Ocorreu um erro do servidor',
        unknownError: 'Ocorreu um erro desconhecido',
        connectionTimeout: 'Tempo limite da conexão esgotado',
        authenticationFailed: 'Falha na autenticação',
        permissionDenied: 'Permissão negada',
        fileNotFound: 'Arquivo não encontrado',
        invalidFormat: 'Formato inválido',
        operationFailed: 'Operação falhou',
        tryAgain: 'Por favor, tente novamente',
        contactSupport: 'Entre em contato com o suporte se o problema persistir',
        sessionNotFound: 'Sessão não encontrada',
        voiceSessionFailed: 'Falha ao iniciar sessão de voz',
        voiceServiceUnavailable: 'Serviço de voz temporariamente indisponível',
        voiceLimitReachedTitle: 'Limite de voz atingido',
        voiceHardLimitReached: ({ hours }: { hours: number }) => `Você usou ${hours}+ horas de voz este mês. Este é o máximo permitido. Você pode configurar seu próprio agente ElevenLabs nas configurações de voz para usar sua própria cota.`,
        voiceConversationLimitReached: 'Você atingiu o número máximo de conversas de voz este mês. Podemos adicionar uso de voz sob demanda no futuro — por favor, abra um issue em github.com/nicepkg/happy/issues se você atingir este limite.',
        oauthInitializationFailed: 'Falha ao inicializar o fluxo OAuth',
        tokenStorageFailed: 'Falha ao armazenar tokens de autenticação',
        oauthStateMismatch: 'Falha na validação de segurança. Por favor, tente novamente',
        tokenExchangeFailed: 'Falha ao trocar código de autorização',
        oauthAuthorizationDenied: 'A autorização foi negada',
        webViewLoadFailed: 'Falha ao carregar a página de autenticação',
        failedToLoadProfile: 'Falha ao carregar o perfil do usuário',
        userNotFound: 'Usuário não encontrado',
        sessionDeleted: 'A sessão foi excluída',
        sessionDeletedDescription: 'Esta sessão foi removida permanentemente',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} deve estar entre ${min} e ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Tentar novamente em ${seconds} ${seconds === 1 ? 'segundo' : 'segundos'}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Erro ${code})`,
    },

    newSession: {
        title: 'Iniciar nova sessão',
        machineOffline: 'A máquina está offline',
        switchMachinesHint: '• Troque de máquina clicando na máquina acima',
    },

    sessionHistory: {
        // Used by session history screen
        empty: 'Nenhuma sessão encontrada',
        daysAgo: ({ count }: { count: number }) => `há ${count} ${count === 1 ? 'dia' : 'dias'}`,
    },

    session: {
        inputPlaceholder: 'Digite uma mensagem ...',
        inactiveArchived: 'Esta sessão está inativa.',
        resumeFromTerminal: 'Para retomá-la pelo terminal:',
        newChat: 'Novo chat',
        statusBarContext: 'Contexto',
        statusBarPathTitle: 'Diretório de trabalho',
        forkAction: 'Bifurcar sessão',
        forkSubtitle: 'Continuar em uma nova sessão com o mesmo contexto',
        duplicateAction: 'Duplicar a partir da mensagem…',
        duplicateSubtitle: 'Voltar a um ponto escolhido e tentar de novo',
        forkFromHere: 'Bifurcar daqui',
        duplicateSheetTitle: 'Escolha um ponto de retrocesso',
        duplicateSheetSubtitle: 'A nova sessão manterá o turno escolhido completo (sua mensagem e a resposta do agente) e descartará as mensagens seguintes.',
        duplicateSheetConfirm: 'Duplicar',
        duplicateSheetEmpty: 'Ainda não há mensagens elegíveis para retrocesso nesta sessão.',
        duplicateRowDisabled: 'Esta mensagem não pode ser usada como ponto de retrocesso.',
        forkedFromLabel: 'Bifurcado de',
        forkedFromSubtitle: 'Abrir a sessão da qual foi bifurcada',
        forkErrorOffline: 'Esta máquina está offline. A bifurcação só está disponível enquanto a máquina da sessão estiver online.',
        forkErrorMissingUuid: 'O ponto de retrocesso escolhido não existe mais na sessão de origem — tente bifurcar sem truncar.',
        forkErrorMissingMetadata: 'Faltam metadados da sessão necessários para bifurcar.',
        forkErrorGeneric: 'Não foi possível bifurcar a sessão.',
        forkClaudeOnly: 'A bifurcação atualmente só é suportada para sessões Claude.',
    },

    commandPalette: {
        placeholder: 'Digite um comando ou pesquise...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Encerrar sessão',
        killSessionConfirm: 'Tem certeza de que deseja encerrar esta sessão?',
        archiveSession: 'Arquivar sessão',
        archiveSessionConfirm: 'Tem certeza de que deseja arquivar esta sessão?',
        happySessionIdCopied: 'ID da sessão Happy copiado para a área de transferência',
        failedToCopySessionId: 'Falha ao copiar ID da sessão Happy',
        happySessionId: 'ID da sessão Happy',
        claudeCodeSessionId: 'ID da sessão Claude Code',
        claudeCodeSessionIdCopied: 'ID da sessão Claude Code copiado para a área de transferência',
        codexThreadId: 'ID da thread do Codex',
        codexThreadIdCopied: 'ID da thread do Codex copiado para a área de transferência',
        aiProvider: 'Provedor de IA',
        failedToCopyClaudeCodeSessionId: 'Falha ao copiar ID da sessão Claude Code',
        failedToCopyCodexThreadId: 'Falha ao copiar ID da thread do Codex',
        metadataCopied: 'Metadados copiados para a área de transferência',
        failedToCopyMetadata: 'Falha ao copiar metadados',
        failedToKillSession: 'Falha ao encerrar sessão',
        failedToArchiveSession: 'Falha ao arquivar sessão',
        connectionStatus: 'Status da conexão',
        created: 'Criado',
        lastUpdated: 'Última atualização',
        sequence: 'Sequência',
        quickActions: 'Ações rápidas',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionNeedsHappyAgent: 'Resume is unavailable on this machine. Run `happy-agent auth login` to enable it.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Claude or Codex identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        killSessionSubtitle: 'Encerrar imediatamente a sessão',
        archiveSessionSubtitle: 'Arquivar esta sessão e pará-la',
        metadata: 'Metadados',
        host: 'Host',
        path: 'Caminho',
        operatingSystem: 'Sistema operacional',
        processId: 'ID do processo',
        happyHome: 'Diretório Happy',
        copyMetadata: 'Copiar metadados',
        agentState: 'Estado do agente',
        controlledByUser: 'Controlado pelo usuário',
        pendingRequests: 'Solicitações pendentes',
        activity: 'Atividade',
        thinking: 'Pensando',
        thinkingSince: 'Pensando desde',
        cliVersion: 'Versão do CLI',
        cliVersionOutdated: 'Atualização do CLI necessária',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Versão ${currentVersion} instalada. Atualize para ${requiredVersion} ou posterior`,
        updateCliInstructions: 'Por favor execute npm install -g happy@latest',
        deleteSession: 'Excluir sessão',
        deleteSessionSubtitle: 'Remover permanentemente esta sessão',
        deleteSessionConfirm: 'Excluir sessão permanentemente?',
        deleteSessionWarning: 'Esta ação não pode ser desfeita. Todas as mensagens e dados associados a esta sessão serão excluídos permanentemente.',
        failedToDeleteSession: 'Falha ao excluir sessão',
        sessionDeleted: 'Sessão excluída com sucesso',
        worktreeCleanupTitle: 'Excluir Worktree?',
        worktreeCleanupMessage: 'O Worktree não tem alterações não confirmadas. Deseja excluir os arquivos do Worktree?',
        worktreeCleanupDelete: 'Excluir Worktree',
        worktreeCleanupKeep: 'Manter arquivos',

    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Pronto para programar?',
            installCli: 'Instale o Happy CLI',
            runIt: 'Execute',
            scanQrCode: 'Escaneie o código QR',
            openCamera: 'Abrir câmera',
        },
        agentGoalBar: {
            currentGoal: 'Objetivo atual',
            accessibilityLabel: ({ goal }: { goal: string }) => `Objetivo atual: ${goal}`,
            clearGoal: 'Limpar objetivo',
            stopGoal: 'Parar objetivo',
            editGoal: 'Editar objetivo',
        },
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Contexto ${used} de ${total} tokens, ${percent}%`,
            limitFiveHour: 'Limite de 5 horas',
            limitSevenDay: 'Limite de 7 dias',
            limitResets: ({ time }: { time: string }) => `redefine ${time}`,
            limitAsOf: ({ age }: { age: string }) => `há ${age}`,
            limitRemaining: ({ percent }: { percent: number }) => `${percent}% restante`,
        },
    },

    agentInput: {
        permissionMode: {
            title: 'MODO DE PERMISSÃO',
            default: 'Padrão',
            acceptEdits: 'Aceitar edições',
            plan: 'Modo de planejamento',
            dontAsk: 'Não perguntar',
            bypassPermissions: 'Modo Yolo',
            badgeAcceptAllEdits: 'Aceitar todas as edições',
            badgeBypassAllPermissions: 'Ignorar todas as permissões',
            badgePlanMode: 'Modo de planejamento',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
            openclaw: 'OpenClaw',
        },
        model: {
            title: 'MODELO',
            configureInCli: 'Configurar modelos nas configurações do CLI',
        },
        effort: {
            title: 'ESFORÇO',
        },
        codexPermissionMode: {
            title: 'MODO DE PERMISSÃO CODEX',
            default: 'Configurações do CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            defaultDescription: 'perguntar antes de comandos não confiáveis',
            readOnlyDescription: 'sem escrita',
            safeYoloDescription: 'sem perguntas, sandbox do espaço de trabalho',
            yoloDescription: 'sem perguntas, acesso total',
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
            title: 'MODO DE PERMISSÃO GEMINI',
            default: 'Padrão',
            autoEdit: 'Edição automática',
            yolo: 'YOLO',
            plan: 'Planejamento',
            badgeAutoEdit: 'Edição automática',
            badgeYolo: 'YOLO',
            badgePlan: 'Planejamento',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% restante`,
        },
        suggestion: {
            fileLabel: 'ARQUIVO',
            folderLabel: 'PASTA',
        },
        noMachinesAvailable: 'Sem máquinas',
    },

    machineLauncher: {
        showLess: 'Mostrar menos',
        showAll: ({ count }: { count: number }) => `Mostrar todos (${count} caminhos)`,
        enterCustomPath: 'Inserir caminho personalizado',
        offlineUnableToSpawn: 'Não é possível criar nova sessão, você está offline',
    },

    agentQuestion: {
        title: "Pergunta",
        submit: "Enviar resposta",
        chooseMultiple: "Escolha todas as que se aplicam",
        ownAnswer: "Sua própria resposta",
        ownAnswerPlaceholder: "Escreva uma resposta",
        submitFailed: "Não foi possível enviar sua resposta",
        dismiss: "Dispensar",
        unsupportedTitle: "Solicitação não suportada",
        unsupportedDescription: ({ kind }: { kind: string }) => `Esta versão do Happy não pode exibir uma solicitação «${kind}». Atualize o app para responder.`,
        moreQuestions: ({ count }: { count: number }) =>
            count === 1 ? "mais 1 pergunta" : `${count} perguntas a mais`,
    },

    sidebar: {
        sessionsTitle: 'Happy',
        showArchived: 'Mostrar arquivadas',
        hideArchived: 'Ocultar arquivadas',
        newSession: 'Nova sessão',
        projects: "Projetos",
    },

    zen: {
        toggle: 'Modo zen',
    },

    toolView: {
        input: 'Entrada',
        output: 'Saída',
    },

    toolGroup: {
        editedFile: 'Edited file',
        editedFiles: ({ count }: { count: number }) => count === 1 ? 'Editou 1 arquivo' : `Editou ${count} arquivos`,
        readFiles: ({ count }: { count: number }) => count === 1 ? 'Leu 1 arquivo' : `Leu ${count} arquivos`,
        ranCommands: ({ count }: { count: number }) => count === 1 ? 'Executou 1 comando' : `Executou ${count} comandos`,
        searched: ({ count }: { count: number }) => count === 1 ? 'Pesquisou 1 vez' : `Pesquisou ${count} vezes`,
        fetchedUrls: ({ count }: { count: number }) => count === 1 ? 'Obteve 1 URL' : `Obteve ${count} URLs`,
        ranTasks: ({ count }: { count: number }) => count === 1 ? 'Executou 1 tarefa' : `Executou ${count} tarefas`,
        usedTools: ({ count }: { count: number }) => count === 1 ? 'Usou 1 ferramenta' : `Usou ${count} ferramentas`,
        workedFor: ({ duration }: { duration: string }) => `Worked ${duration}`,
    },

    tools: {
        fullView: {
            description: 'Descrição',
            inputParams: 'Parâmetros de entrada',
            output: 'Saída',
            error: 'Erro',
            completed: 'Ferramenta concluída com sucesso',
            noOutput: 'Nenhuma saída foi produzida',
            running: 'Ferramenta está executando...',
            rawJsonDevMode: 'JSON bruto (modo desenvolvedor)',
        },
        taskView: {
            initializing: 'Inicializando agente...',
            moreTools: ({ count }: { count: number }) => `+${count} mais ${plural({ count, singular: 'ferramenta', plural: 'ferramentas' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Edição ${index} de ${total}`,
            replaceAll: 'Substituir tudo',
        },
        names: {
            task: 'Tarefa',
            terminal: 'Terminal',
            searchFiles: 'Buscar arquivos',
            search: 'Buscar',
            searchContent: 'Buscar conteúdo',
            listFiles: 'Listar arquivos',
            planProposal: 'Proposta de plano',
            readFile: 'Ler arquivo',
            editFile: 'Editar arquivo',
            writeFile: 'Escrever arquivo',
            fetchUrl: 'Buscar URL',
            readNotebook: 'Ler notebook',
            editNotebook: 'Editar notebook',
            todoList: 'Lista de tarefas',
            webSearch: 'Busca web',
            reasoning: 'Raciocínio',
            applyChanges: 'Atualizar arquivo',
            viewDiff: 'Alterações do arquivo atual',
            question: 'Pergunta',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Buscar(padrão: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Buscar(caminho: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Buscar URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Editar notebook(arquivo: ${path}, modo: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Lista de tarefas(quantidade: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Busca web(consulta: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(padrão: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} edições)`,
            readingFile: ({ file }: { file: string }) => `Lendo ${file}`,
            writingFile: ({ file }: { file: string }) => `Escrevendo ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Modificando ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Modificando ${count} arquivos`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} e ${count} mais`,
            showingDiff: 'Mostrando alterações',
        },
        askUserQuestion: {
            submit: 'Enviar resposta',
            multipleQuestions: ({ count }: { count: number }) => `${count} ${plural({ count, singular: 'pergunta', plural: 'perguntas' })}`,
            other: 'Outro',
            otherDescription: 'Digite sua própria resposta',
            otherPlaceholder: 'Digite sua resposta...',
        }
    },

    files: {
        changes: 'Alterações',
        searchPlaceholder: 'Buscar arquivos...',
        detachedHead: 'HEAD desanexado',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} preparados • ${unstaged} não preparados`,
        notRepo: 'Não é um repositório git',
        notUnderGit: 'Este diretório não está sob controle de versão git',
        searching: 'Buscando arquivos...',
        noFilesFound: 'Nenhum arquivo encontrado',
        noFilesInProject: 'Nenhum arquivo no projeto',
        tryDifferentTerm: 'Tente um termo de busca diferente',
        searchResults: ({ count }: { count: number }) => `Resultados da busca (${count})`,
        projectRoot: 'Raiz do projeto',
        stagedChanges: ({ count }: { count: number }) => `Alterações preparadas (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Alterações não preparadas (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Carregando ${fileName}...`,
        binaryFile: 'Arquivo binário',
        cannotDisplayBinary: 'Não é possível exibir o conteúdo do arquivo binário',
        diff: 'Diff',
        file: 'Arquivo',
        fileEmpty: 'Arquivo está vazio',
        noChanges: 'Nenhuma alteração para exibir',
        noChangesTitle: 'Sem alterações',
        noChangesSubtitle: 'A árvore de trabalho está limpa',
        deleted: 'Excluído',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'arquivo modificado' : 'arquivos modificados'}`,
        allFiles: 'Todos os arquivos',
        addPanel: 'Adicionar painel',
        closePanel: 'Fechar painel',
        editFile: 'Editar',
        saveFile: 'Salvar',
        failedToRead: 'Falha ao ler arquivo',
        failedToSave: 'Falha ao salvar arquivo',
        fileConflict: 'Conflito de arquivo',
        fileConflictDescription: 'Este arquivo foi modificado no dispositivo enquanto você o editava. Recarregue para ver a versão mais recente.',
        reload: 'Recarregar',
        overwrite: 'Sobrescrever',
    },
    sideChat: {
        panelTitle: 'Chat lateral',
        emptyTitle: 'Inicie um chat lateral',
        emptySubtitle: 'Pergunte algo ao agente à parte. Ele herda o contexto deste chat, mas permanece isolado — nada aqui afeta a conversa principal.',
        startButton: 'Iniciar chat lateral',
        creating: 'Iniciando chat lateral…',
        unavailable: 'Esta sessão ainda não pode iniciar um chat lateral — aguarde o agente ficar online.',
        composerPlaceholder: 'Mensagem no chat lateral…',
        expand: 'Abrir em tela cheia',
        tabLabel: ({ index }: { index: number }) => `Chat lateral ${index}`,
        newChat: 'Novo chat lateral',
        close: 'Fechar chat lateral',
    },



    settingsLanguage: {
        // Language settings screen
        title: 'Idioma',
        description: 'Escolher o idioma preferido para a interface do aplicativo. Isso vai ser sincronizado em todos os seus dispositivos.',
        currentLanguage: 'Idioma atual',
        automatic: 'Automático',
        automaticSubtitle: 'Detectar das configurações do dispositivo',
        needsRestart: 'Idioma alterado',
        needsRestartMessage: 'O aplicativo precisa ser reiniciado para aplicar a nova configuração de idioma.',
        restartNow: 'Reiniciar agora',
    },


    updateBanner: {
        updateAvailable: 'Atualização disponível',
        pressToApply: 'Pressione para aplicar a atualização',
        whatsNew: 'Novidades',
        seeLatest: 'Veja as atualizações e melhorias mais recentes',
        nativeUpdateAvailable: 'Atualização do aplicativo disponível',
        tapToUpdateAppStore: 'Toque para atualizar na App Store',
        tapToUpdatePlayStore: 'Toque para atualizar na Play Store',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Versão ${version}`,
        noEntriesAvailable: 'Nenhuma entrada de changelog disponível.',
    },


    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Autenticar terminal',
        pasteUrlFromTerminal: 'Cole a URL de autenticação do seu terminal',
        deviceLinkedSuccessfully: 'Dispositivo vinculado com sucesso',
        terminalConnectedSuccessfully: 'Terminal conectado com sucesso',
        invalidAuthUrl: 'URL de autenticação inválida',
        failedToConnectTerminal: 'Falha ao conectar terminal',
        cameraPermissionsRequiredToConnectTerminal: 'Permissões de câmera são necessárias para conectar terminal',
        failedToLinkDevice: 'Falha ao vincular dispositivo',
        cameraPermissionsRequiredToScanQr: 'Permissões de câmera são necessárias para escanear códigos QR'
    },

    navigation: {
        // Navigation titles and screen headers
        whatsNew: 'Novidades',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Cliente móvel Codex e Claude Code',
        subtitle: 'Criptografado ponta a ponta e sua conta é armazenada apenas no seu dispositivo.',
        createAccount: 'Criar conta',
        linkOrRestoreAccount: 'Vincular ou restaurar conta',
        loginWithMobileApp: 'Fazer login com aplicativo móvel',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Curtindo o aplicativo?',
        feedbackPrompt: 'Adoraríamos ouvir seu feedback!',
        yesILoveIt: 'Sim, eu amo!',
        notReally: 'Não muito'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copiado para a área de transferência`
    },

    machine: {
        offlineUnableToSpawn: 'Inicializador desativado enquanto a máquina está offline',
        offlineHelp: '• Verifique se seu computador está online\n• Execute `happy daemon status` para diagnosticar\n• Você está usando a versão mais recente do CLI? Atualize com `npm install -g happy@latest`',
        launchNewSessionInDirectory: 'Iniciar nova sessão no diretório',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Mudou para o modo ${mode}`,
        unknownEvent: 'Evento desconhecido',
        usageLimitUntil: ({ time }: { time: string }) => `Limite de uso atingido até ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: 'horário desconhecido',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: 'Sim, e não perguntar para esta sessão',
            stopAndExplain: 'Parar, e explicar o que fazer',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Sim, permitir todas as edições durante esta sessão',
            yesAllowEverything: 'Sim, permitir tudo durante esta sessão',
            yesForTool: 'Sim, não perguntar novamente para esta ferramenta',
            noTellClaude: 'Não, fornecer feedback',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: 'Selecionar intervalo de texto',
        title: 'Selecionar texto',
        noTextProvided: 'Nenhum texto fornecido',
        textNotFound: 'Texto não encontrado ou expirado',
        textCopied: 'Texto copiado para a área de transferência',
        failedToCopy: 'Falha ao copiar o texto para a área de transferência',
        noTextToCopy: 'Nenhum texto disponível para copiar',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Código copiado',
        copyFailed: 'Falha ao copiar',
        mermaidRenderFailed: 'Falha ao renderizar diagrama mermaid',
    },




    imageUpload: {
        permissionTitle: 'Acesso à biblioteca de fotos',
        permissionMessage: 'Permita o acesso à sua biblioteca de fotos para anexar imagens às mensagens.',
        limitTitle: 'Limite de imagens atingido',
        limitMessage: ({ max }: { max: number }) => `Você pode anexar até ${max} imagens por mensagem.`,
        fileTooLargeTitle: 'Arquivo muito grande',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" excede o limite de ${maxMb}MB e não foi adicionado.`,
        uploadFailedTitle: 'Falha no envio',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'Não foi possível enviar uma imagem e não foi enviada.'
            : `Não foi possível enviar ${count} imagens e não foram enviadas.`,
        notSupportedTitle: 'Imagens não suportadas',
        notSupportedMessage: 'Este agente não suporta anexos de imagem. As imagens não foram enviadas.',
    },

} as const;

export type TranslationsPt = typeof pt;
