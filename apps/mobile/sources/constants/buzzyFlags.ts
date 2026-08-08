/**
 * Buzzy product flags (spec.md out-of-scope + P1 boundaries).
 *
 * Prefer flags over deep deletion so Happy diffs stay reviewable.
 * The Buzz adapter lane should treat these as the default product shape.
 */
export const BUZZY_FLAGS = {
    /** No live PTY on Buzz — hide Happy terminal connect UI (spec: stub terminal*). */
    hideTerminalUI: true,
    /**
     * Happy is single-user account oriented; Buzzy sessions belong to a channel.
     * Keep Happy auth compiling for now; hide secondary social/account chrome
     * that will not map to Buzz channel membership.
     */
    hideFriendsSocial: true,
    /** Stub terminalCreate/Stop/Connect in RigTransport (always true for Buzzy). */
    stubTerminalTransport: true,
} as const;

export type BuzzyFlags = typeof BUZZY_FLAGS;
