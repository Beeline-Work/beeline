import { beelineThemes, type BeelineThemeTokens } from './buzz/groknight';
import { APP_UI_SIZE_SCALE, type AppUiSize } from './ui-size';

/**
 * The legacy `theme.colors` shape that older screens still read, derived
 * entirely from the active Beeline token set. Every value comes from `buzz`,
 * so Bone never inherits a dark-theme literal and Obsidian never inherits a
 * platform default.
 */
function createBeelineAppTheme(buzz: BeelineThemeTokens) {
    return {
        dark: buzz.dark,
        colors: {
            text: buzz.textPrimary,
            textSecondary: buzz.textMuted,
            textLink: buzz.accent,
            textDestructive: buzz.dialogDanger,
            warning: buzz.warning,
            surface: buzz.bgBase,
            surfaceRipple: buzz.bgPressed,
            surfacePressed: buzz.bgPressed,
            surfaceSelected: buzz.bgHighlight,
            surfacePressedOverlay: buzz.bgPressed,
            surfaceHigh: buzz.bgRaised,
            surfaceHighest: buzz.bgHighlight,
            divider: buzz.border,
            groupped: {
                background: buzz.bgTerminal,
                chevron: buzz.chrome,
                sectionTitle: buzz.textMuted,
            },
            header: {
                background: buzz.bgBase,
                tint: buzz.textPrimary,
            },
            input: {
                background: buzz.bgRaised,
                text: buzz.textPrimary,
                placeholder: buzz.textMuted,
            },
            button: {
                primary: {
                    background: buzz.buttonPrimaryFill,
                    tint: buzz.buttonPrimaryText,
                    disabled: buzz.textDisabled,
                },
                secondary: { tint: buzz.buttonSecondaryText },
            },
            radio: {
                active: buzz.accent,
                inactive: buzz.borderStrong,
                dot: buzz.accent,
            },
            status: {
                connecting: buzz.accent,
                disconnected: buzz.textMuted,
                error: buzz.dialogDanger,
                default: buzz.textMuted,
                // Live/online is brass product-wide (DESIGN.md color exception
                // #1) — the legacy iOS green never ships on a Beeline surface.
                connected: buzz.accent,
            },
            // Settings toggles read as Beeline chrome, not iOS defaults: the
            // track spends the same brass as every other live/affirmative
            // state, and the thumb carries canvas ink on it (Speakeasy's
            // accent.foreground relationship).
            switch: {
                track: {
                    active: buzz.accent,
                    inactive: buzz.bgTexturePeak,
                },
                thumb: {
                    active: buzz.bgTerminal,
                    inactive: buzz.textMuted,
                },
            },
            userMessageBackground: buzz.bgHighlight,
            userMessageText: buzz.textPrimary,
            agentMessageText: buzz.textPrimary,
            agentEventText: buzz.textMuted,
            gitBranchText: buzz.textMuted,
            gitFileCountText: buzz.textMuted,
        },
        buzz,
    };
}

function scaleTypeRole<T extends BeelineThemeTokens['type'][keyof BeelineThemeTokens['type']]>(
    role: T,
    scale: number,
): T {
    return {
        ...role,
        fontSize: role.fontSize * scale,
        lineHeight: role.lineHeight * scale,
    } as T;
}

function scaleBeelineTypography(theme: BeelineThemeTokens, uiSize: AppUiSize): BeelineThemeTokens {
    const scale = APP_UI_SIZE_SCALE[uiSize];
    if (scale === 1) return theme;
    return {
        ...theme,
        type: Object.fromEntries(
            Object.entries(theme.type).map(([name, role]) => [name, scaleTypeRole(role, scale)]),
        ) as unknown as BeelineThemeTokens['type'],
        transcriptCard: {
            ...theme.transcriptCard,
            bodySize: theme.transcriptCard.bodySize * scale,
            bodyLineHeight: theme.transcriptCard.bodyLineHeight * scale,
            codePathSize: theme.transcriptCard.codePathSize * scale,
            rowTitleSize: theme.transcriptCard.rowTitleSize * scale,
            rowKindSize: theme.transcriptCard.rowKindSize * scale,
            actionSize: theme.transcriptCard.actionSize * scale,
        },
        proseSize: theme.proseSize * scale,
        proseLineHeight: theme.proseLineHeight * scale,
        leadSize: theme.leadSize * scale,
        leadLineHeight: theme.leadLineHeight * scale,
    } as BeelineThemeTokens;
}

export function createSizedBeelineTheme(theme: BeelineThemeTokens, uiSize: AppUiSize) {
    return createBeelineAppTheme(scaleBeelineTypography(theme, uiSize));
}

export const obsidianTheme = createSizedBeelineTheme(beelineThemes.obsidian, 'medium');
export const obsidianSmallTheme = createSizedBeelineTheme(beelineThemes.obsidian, 'small');
export const obsidianLargeTheme = createSizedBeelineTheme(beelineThemes.obsidian, 'large');
export const boneTheme = createSizedBeelineTheme(beelineThemes.bone, 'medium');
export const boneSmallTheme = createSizedBeelineTheme(beelineThemes.bone, 'small');
export const boneLargeTheme = createSizedBeelineTheme(beelineThemes.bone, 'large');
export type BeelineAppTheme = typeof obsidianTheme;
