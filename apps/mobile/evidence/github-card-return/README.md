# GitHub repository card — approved mock v2

`approved-v2/comparison.html` places each approved mock panel beside its native
Android capture. `normal.png`, `error.png`, `linked.png` and `workspace.png` show
the four requested states. The agent mark is the real IdentityMark, using
Beebee's production public identity and owl face. The state selectors and
developer-menu bubble belong to the local proof harness. All four captures were
recaptured after the text-style corrections. The comparison preserves the full
Workspace mock panel, including its left edge.

The normal body uses primary ink; only the error icon/title use danger color.
The reason and regular-weight Dismiss use secondary text. The welcome title
uses the existing large name typography with semibold, fitting only on overflow.
Create Workspace uses the existing `PlusGlyph` from `MicGlyph.tsx`; Join keeps
the existing `MembersAgentsGlyph`. No new glyph or color is introduced.

## Reproduced

**R-GITHUB-CARD:** return a failed GitHub connection to a Room with two cards.
The original implementation repeats the error, nested banner and conflicting
actions on all cards, and replays the URL error after remount. Original Android
screenshots remain here as `native-before-*` and `android-before-*`.

**R-GITHUB-LANDING:** a fresh nonempty workspace response arrives before the
subscribed surface snapshot. The original route combines a confirmed boolean
with the absent snapshot, reads zero workspaces and navigates to community.
`approved-v2/cold-cache-before.txt` records the failing original-route test.

## Demonstrated

The initiating card now consumes the error query, displays the approved inline
error and Dismiss/Try again actions, and leaves other cards normal. Dismiss and
remount do not replay it; the installation result and picker parameters survive.
A settled card with an existing repository name renders the compact record.
The card and its repository list do not carry visibility. Under Ruby’s repair
order, Connected therefore shows `owner/repo` only; it does not claim private or
public. The original server producer write and System-message lock are unchanged. The Workspace screen uses the shared PageHeader,
HullDialogInput boxed variant, existing glyphs and IndexRow dividers.

The native captures use the PR debug APK on an isolated API 36 emulator with
actual production components, fonts and tokens. Navigation, eligibility,
account reads and phone operations are fixture adapters. No live credentials
or production account data beyond the public agent identity enter the fixture.

`approved-v2/local-web-error.png` shows the same components built by Expo web
on localhost. Squire also inspected that page and confirmed the approved error
copy, both actions and the independent normal card.

`approved-v2/cold-cache-navigation.txt` is the accepted instrumented substitute
for sign-in footage: the actual channels route starts with an empty cache and a
fresh workspace response while the subscribed snapshot is withheld. The full
navigation trace is empty, a chats read starts, and no community navigation
occurs. The same test fails against the original route. Existing tests preserve
the redirect for a confirmed truly empty account. This is not a claimed
production sign-in recording.

## Local fixture

The source is `scripts/github-card-proof.tsx`, with
`github-card-proof-adapters.tsx`, `github-card-proof-theme.ts` and the Metro
resolver adapter `github-card-proof-metro.cjs`. For the isolated proof only,
back up the app entry and Metro config, point the entry to this proof, append
`require('./scripts/github-card-proof-metro.cjs')(module.exports,__dirname)` to
the config, and start Expo with `--dev-client --port 18765`.
The web entry accepts `?state=Normal|Error|Linked|Workspace`; the native proof
has the same state selectors. Restore both production entry/config files before
validation or committing. They are unchanged in this PR.

## Production ownership and validation

Read-only SQL confirms lunchboxfortwo GitHub subject 269599412 belongs to the
owner identity `34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334`.
No retained failed auth flow identifies the starting session. The mounted auth
callback test explicitly reconnects the same linked identity and succeeds;
the existing ownership guard needs no change.

Targeted mobile, auth, design and server tests, root typecheck and shared UI
policy validate this change. The production browser test was removed by brief
revision 4 because production cannot run PR code; the posted browser share was
closed. No release was dispatched.

## Bounded mobile repair

`approved-v2/mobile-repair-proof.txt` records both failures on head 161aac005
and the passing targeted suites after repair. The Workspace label now names
`theme.buzz.type.meta` explicitly, the same object previously aliased by hull.
Local Expo web captures `workspace-font-before.png` and `workspace-font-after.png`
have identical label pixels and identical content above the developer badge.
The settings browser proof observes the approved conflict notice through
`githubConnectionErrorMessage`, rather than an obsolete hardcoded sentence.
