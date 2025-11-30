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

