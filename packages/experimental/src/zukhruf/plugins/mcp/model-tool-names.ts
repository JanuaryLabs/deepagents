import { hash } from 'node:crypto';

// Ported from Codex codex-rs/codex-mcp/src/tools.rs (normalize_tools_for_model_with_prefix
// and the helpers after it) and codex-rs/codex-mcp/src/mcp/mod.rs
// (sanitize_responses_api_tool_name). Each mcp() plugin is one server, so the
// namespace step that disambiguates two servers is not reached here.
const LEGACY_MCP_TOOL_NAME_PREFIX = 'mcp__';
const MCP_TOOL_NAME_DELIMITER = '__';
const MAX_TOOL_NAME_LENGTH = 128;
const CALLABLE_NAME_HASH_LEN = 12;

interface Candidate<T> {
  tool: T;
  rawToolIdentity: string;
  callableName: string;
}

/**
 * Keys a server's tools by the name the model sees, `mcp__<server>__<tool>`,
 * sanitized, capped at 128 characters and made unique with a sha1 suffix
 * exactly as Codex does. The tools themselves still call the server by their
 * original MCP name.
 */
export function modelToolNames<T>(
  server: string,
  tools: Record<string, T>,
): Record<string, T> {
  const sanitizedServer = sanitize(server);
  const namespace = sanitizedServer.startsWith(LEGACY_MCP_TOOL_NAME_PREFIX)
    ? sanitizedServer
    : `${LEGACY_MCP_TOOL_NAME_PREFIX}${sanitizedServer}`;
  const rawNamespaceIdentity = `${server}\0${server}\0`;
  const candidates: Candidate<T>[] = Object.entries(tools).map(
    ([name, tool]) => ({
      tool,
      rawToolIdentity: `${rawNamespaceIdentity}\0${name}\0${name}`,
      callableName: sanitize(name),
    }),
  );

  const sameName = Map.groupBy(
    candidates,
    (candidate) => candidate.callableName,
  );
  for (const colliding of sameName.values()) {
    if (colliding.length < 2) continue;
    for (const candidate of colliding) {
      candidate.callableName = `${candidate.callableName}${hashSuffix(candidate.rawToolIdentity)}`;
    }
  }

  candidates.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.rawToolIdentity),
      Buffer.from(right.rawToolIdentity),
    ),
  );

  const usedNames = new Set<string>();
  const named: Record<string, T> = {};
  for (const candidate of candidates) {
    const [callableNamespace, callableName] = uniqueCallableParts(
      namespace,
      candidate.callableName,
      candidate.rawToolIdentity,
      usedNames,
    );
    named[`${callableNamespace}${MCP_TOOL_NAME_DELIMITER}${callableName}`] =
      candidate.tool;
  }
  return named;
}

/** Every character outside [A-Za-z0-9_] becomes `_`; an empty name becomes `_`. */
function sanitize(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_]/gu, '_') || '_';
}

function hashSuffix(rawIdentity: string): string {
  const digest = hash('sha1', rawIdentity, 'hex');
  return `_${digest.slice(0, CALLABLE_NAME_HASH_LEN)}`;
}

function fitCallablePartsWithHash(
  namespace: string,
  toolName: string,
  rawIdentity: string,
): [string, string] {
  const suffix = hashSuffix(rawIdentity);
  const maxToolLength = Math.max(
    0,
    MAX_TOOL_NAME_LENGTH - (namespace.length + MCP_TOOL_NAME_DELIMITER.length),
  );
  if (maxToolLength >= suffix.length) {
    const prefixLength = maxToolLength - suffix.length;
    return [namespace, `${toolName.slice(0, prefixLength)}${suffix}`];
  }
  const maxNamespaceLength = Math.max(
    0,
    MAX_TOOL_NAME_LENGTH - (suffix.length + MCP_TOOL_NAME_DELIMITER.length),
  );
  return [namespace.slice(0, maxNamespaceLength), suffix];
}

function uniqueCallableParts(
  namespace: string,
  toolName: string,
  rawIdentity: string,
  usedNames: Set<string>,
): [string, string] {
  const modelName = `${namespace}${toolName}`;
  if (
    modelName.length + MCP_TOOL_NAME_DELIMITER.length <= MAX_TOOL_NAME_LENGTH &&
    !usedNames.has(modelName)
  ) {
    usedNames.add(modelName);
    return [namespace, toolName];
  }
  for (let attempt = 0; ; attempt++) {
    const hashInput =
      attempt === 0 ? rawIdentity : `${rawIdentity}\0${attempt}`;
    const [fittedNamespace, fittedName] = fitCallablePartsWithHash(
      namespace,
      toolName,
      hashInput,
    );
    const fittedModelName = `${fittedNamespace}${fittedName}`;
    if (!usedNames.has(fittedModelName)) {
      usedNames.add(fittedModelName);
      return [fittedNamespace, fittedName];
    }
  }
}
