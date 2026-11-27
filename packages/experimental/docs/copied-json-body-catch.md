# Copied: a response body that is not JSON

One catch exists in three places. Counted by places it is at its third copy,
but each copy is four lines in packages that run in different places (this
package on Node; devtool's host UI in the browser), and a shared module would
add a dependency for four lines (the user's choice on 2026-11-25, #5020). Keep
the copies, mirror every fix in all three, and name their files in the commit.

react-genai's copy (`describeUploadFailure` in `zukhruf-chat-transport.ts`) is
gone: a refused upload now throws the AI SDK's `APICallError` with the
response's text as `responseBody`, and parses no JSON (#6223).

| Code                                               | Copies                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A `response.json()` that tolerates a non-JSON body | `src/providers/claude/accounts.ts` (the sign-in and the refresh), `packages/devtool/host/ui/src/app/schedules-data.ts` |

## A `response.json()` that tolerates a non-JSON body

- Same: each site parses the body with a schema and treats a body that is not
  JSON as no body, so the schema fails and the site reports the failure it
  reports for a wrong body:

  ```ts
  await response.json().catch((error: unknown) => {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  });
  ```

  `response.json()` rejects with a `SyntaxError` for a body that does not
  parse. Any other rejection (an aborted or broken body stream) is a different
  failure and propagates.

- Differs: what the failed schema leads to. The sign-in of `accounts.ts`
  publishes an `error` status for the pending sign-in, its refresh throws
  `ClaudeAuthError('invalid-token-response')`, and the schedules client answers
  with the HTTP status message.
