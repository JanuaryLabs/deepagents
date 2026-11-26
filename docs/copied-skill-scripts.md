# Copied skill-script code

The TypeScript scripts of the repo's skills share no module, so a piece that two of them need stays copied until a third place needs it.
This file records each copy.
When you change a copy, make the same change in each copy on its row, and name those files in the commit.

| Piece                                                                                                                                              | Copies                                                                                                       | Differences                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `tsconfig.json` (typed ESLint's project service finds the scripts: extends `tsconfig.base.json`, `noEmit`, `types: ["node"]`, `include: ["*.ts"]`) | `.claude/skills/aisdk-parity/scripts/tsconfig.json`, `.codex/skills/doc-gardener/scripts/tsconfig.json`      | Byte-identical. A third skill with typed scripts extracts one shared tsconfig (#5885). |
| `runCommand` (`execFile` into `{ code, output }`; an exec error keeps its stdout and stderr, anything else is rethrown)                            | `.codex/skills/doc-gardener/scripts/detect-drift.ts`, `.codex/skills/doc-gardener/scripts/run.ts`            | Byte-identical. Two places in one skill. A third place extracts it (#5886).            |
| `slugifyHeading` (a heading's text into its anchor)                                                                                                | `.codex/skills/doc-gardener/scripts/detect-drift.ts`, `.codex/skills/doc-gardener/scripts/fix-links-meta.ts` | Byte-identical. Two places in one skill. A third place extracts it (#5887).            |
