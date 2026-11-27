# Code copied from react-genai

The release's consumer-install check and react-genai's packed-install test both install packed deepagents packages into a throwaway host. Both give the host every `@zukhruf/*` package of the install closure as a `file:` tarball packed from the repo root's `node_modules`, and both point the `@zukhruf` registry at a refused address (`127.0.0.1:9`). A fresh `@zukhruf` release names sibling ranges that the registry may not serve yet, so a registry lookup fails with ETARGET minutes after a release (#6163, #6221).

The rule is copied, not shared, because it has two places. Shared code is extracted when a third place needs it (backlog #6235). Until then, a fix in one copy is made in the other copy too, and the commit names both files.

The path on the left is in `packages/react/genai/test`. The path on the right is in `tools/src`.

## Copied with changes

**`styles-packed-install.test.ts` `packZukhrufClosure()`, `pack()`, `installedManifest()` → `check-consumer-install.ts` `packZukhrufClosure()`, `pack()`, `installedManifest()`.**
Both walk the `dependencies`, `peerDependencies` and `optionalDependencies` of each root's installed manifest, collect every `@zukhruf/*` name, and pack each from `node_modules` into the overrides.

- The check's roots are every `npm:public` project. The test's roots are react-genai's packed siblings and the two `@zukhruf` packages its host imports.
- The check runs `npm pack` synchronously from the repo root. The test runs it with an abort signal.
- The check gives `@zukhruf` packages only as overrides. The test also lists its host's two `@zukhruf` imports as dependencies.

Why: the check proves that every public package installs with one copy each of `ai` and `react`. The test builds one Vite host that follows react-genai's README.
