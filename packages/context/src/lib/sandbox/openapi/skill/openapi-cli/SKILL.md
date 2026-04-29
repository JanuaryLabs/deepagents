---
name: openapi-cli
description: Use this skill any time the user asks to list, inspect, call, or use commands/operations of a bash-exposed API extension (e.g. datahub, github, stripe). These extensions are NOT standard CLIs — they do NOT support `--help` or `-h`. Each extension exposes one bash command (the "group") with a `schema` subcommand for discovery and operations invoked as `<group> <operation> '<json>'`. ALWAYS run `<group> schema` as the first action before doing anything else; never run `<group> --help` or `<group> -h` (they will fail).
---

# Invoking OpenAPI extensions

Each `createOpenAPIExtension` registers one bash command (the **group**) under which every OpenAPI operation becomes a **subcommand**. You invoke operations through the bash tool. There is no separate API surface.

## Always discover first

Before calling any operation, run the `schema` subcommand once per session to learn what's available:

```
<group> schema
```

The output is a single JSON document:

```json
{
  "group": "<group>",
  "operations": [
    {
      "operationId": "...",
      "method": "GET|POST|PUT|PATCH|DELETE",
      "path": "/example/{id}",
      "summary": "...",
      "input": {
        /* JSON Schema 7 */
      }
    }
  ]
}
```

Read `input` to learn the exact field names, types, required keys, and enums for that operation. Do not guess fields.

## Invocation shape

```
<group> <operationId> '<json>'
```

- **One positional JSON argument.** Wrap it in single quotes so the shell parser treats it as one literal token.
- **Flat object.** Pass every field at the top level — path params, query params, body fields, headers all live as flat keys in one object. The extension partitions them automatically based on the spec.
- **No `--flags`.** There are no per-field flags. The whole payload is the JSON.

Example:

```
github listIssues '{"owner":"acme","repo":"app","state":"open","per_page":10}'
```

`owner` and `repo` are path params; `state` and `per_page` are query params. You don't manage that split — the extension does.

## Output format

- **Object response** → one line of JSON on stdout.
- **Array response** → newline-delimited JSON (NDJSON), one item per line. Pipe to `head -n N` to cap before reading the whole list.
- **Errors** → JSON on stderr, exit code 1.

```bash
<group> <operation> '<json>' | head -n 5    # cap arrays
```

## Reading errors

Stderr on failure is always JSON with this shape:

```json
{
  "ok": false,
  "group": "...",
  "operation": "...",
  "code": "...",
  "message": "..."
}
```

Branch on `code`:

| Code                | What it means                                     | What to do                                                                  |
| ------------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| `missing_input`     | No JSON arg passed                                | Add `'<json>'`                                                              |
| `invalid_json`      | JSON didn't parse                                 | Fix the JSON literal                                                        |
| `schema_validation` | Fields don't match the schema                     | Re-read `<group> schema` and fix shape; `issues` array lists each violation |
| `path_param_unsafe` | A path-param value contains a forbidden character | See "Path-param rules" below                                                |
| `request_failed`    | The upstream API errored or network failed        | Read `message`; surface to the user                                         |

## Path-param rules

Path-param values must be **plain segment identifiers**. The extension rejects, _before_ sending the request:

- `/`, `\`, `?`, `#`, `&` (would change the route or query)
- `.` and `..` as full values (would normalize away)
- Control characters (`\x00`–`\x1f`, `\x7f`)
- Pre-encoded sequences (`%2e`, `%2f`, etc. — they get re-decoded)

If the user gives you something like `abc/def` for a single id, that's two segments — clarify with the user instead of forcing it through.

## Workflow

1. Run `<group> schema` once.
2. Find the operation that matches the user's intent (`summary`, `path`, `method`).
3. Build the JSON payload from the `input` schema.
4. Invoke `<group> <operationId> '<json>'`.
5. If `code: "schema_validation"`, read `issues[]` and fix exactly what it says.
6. For list endpoints, prefer `| head -n N` over reading all rows.
