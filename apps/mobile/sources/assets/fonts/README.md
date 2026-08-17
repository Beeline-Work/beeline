# Bundled fonts

Every font shipped in the app is SIL Open Font License 1.1. OFL 1.1 permits
bundling, embedding, and redistribution inside an application at no cost, with
no reserved-font-name restriction triggered here (none of these files are
renamed or modified — `CommitMono-*.ttf` are the upstream `ttfautohint/` builds
copied under a shorter filename, which does not alter the font's internal name).

| Family | Files | Version / source | License |
| --- | --- | --- | --- |
| IBM Plex Sans | `IBMPlexSans-{Regular,Italic,SemiBold}.ttf` | vendored with the Happy fork | SIL OFL 1.1 |
| IBM Plex Mono | `IBMPlexMono-{Regular,Italic,SemiBold}.ttf` | vendored with the Happy fork | SIL OFL 1.1 |
| Bricolage Grotesque | `BricolageGrotesque-Bold.ttf` | vendored with the Happy fork | SIL OFL 1.1 |
| JetBrains Mono | `JetBrainsMono-{Regular,Italic,SemiBold}.ttf` | [JetBrains/JetBrainsMono v2.304](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304) | SIL OFL 1.1 |
| Geist | `Geist-{Regular,Italic,SemiBold}.ttf` | [vercel/geist-font v1.7.2](https://github.com/vercel/geist-font/releases/tag/v1.7.2) | SIL OFL 1.1 |
| Commit Mono | `CommitMono-{Regular,Italic,Bold}.ttf` | [eigilnikolajsen/commit-mono v1.143](https://github.com/eigilnikolajsen/commit-mono/releases/tag/v1.143) | SIL OFL 1.1 |

JetBrains Mono, Geist, and Commit Mono are candidates for the throwaway type
exploration (`sources/buzz/font-exploration.ts`). The follow-up change that
commits a winning direction should delete the losing families from this folder
and from this table.
