### General Rules

- Early development, no users. No backwards compatibility concerns. Do things RIGHT: clean,
  organized, zero tech debt. Never create compatibility shims.

- WE NEVER WANT WORKAROUNDS. we always want FULL implementations that are long term
  suistainable for many >1000 users. so dont come up with half baked solutions

- Important: Do not remove, hide, or rename any existing features or UI options (even
  temporarily) unless I explicitly ask for it. If something isn’t fully wired yet, keep the UX
  surface intact and stub/annotate it instead of deleting it.

- Always ask more questions until you have enough context to give an accurate & confident answer.

### Building packages

To build a package, use the following command:

```sh
nx run <package-name>:build
```

For example, to build the `agent` package, run:

```sh
nx run agent:build
```

### Running Typescript files

We use node version that support running typescript files directly without precompilation. To run a typescript file, use the following command:

```sh
node path/to/file.ts
```

### Running and Writing unit test

We write tests exclusively using nodejs test running.

To run unit tests for a specific package, use the following command:

```sh
node --test path/to/package/test/file.test.ts
```

### Running Evals

```bash
nx run text2sql:eval                    # Run all evals
nx run text2sql:eval path/to/eval.ts    # Run specific eval file
```

To debug failing evals test cases

```bash
nx run text2sql:eval-debug --list
```

To run a specific eval test case

```bash
EVAL_INDEX=<test-case-index> nx run text2sql:eval path/to/eval.ts
```
