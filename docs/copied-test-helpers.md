# Copied test helpers

A package exports no test support, so a test helper that two packages need stays copied.
Inside one package, the third place moves to the package's helper.
This file records each copy.
When you change a copy, make the same change in each copy on its row, and name those files in the commit.

| Helper                                                  | Copies                                                                                                                                                            | Differences                                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `buildSandbox` (a plain virtual `createBashTool` setup) | `packages/context/test/helpers/build-sandbox.ts`, `packages/experimental/src/testing/build-sandbox.fixture.ts`, `packages/text2sql/test/helpers/build-sandbox.ts` | Byte-identical. The `.fixture.ts` suffix keeps the experimental copy out of that package's library build. |
| `unusedSandbox` (the same setup, inline)                | `packages/devtool/host/src/devtool.integration.test.ts`, `packages/devtool/host/src/traces/traces.integration.test.ts`                                            | Two places in one package. A third place moves it to a devtool helper (#4126).                            |
