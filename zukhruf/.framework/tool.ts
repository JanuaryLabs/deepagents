/**
 * Declaration-layer tool definition: a pure passthrough of the AI SDK's
 * `tool()` (full generics, zero side effects). Set `needsApproval: true` to
 * pause the turn on this tool's call until `runtime.approve()`/`deny()`.
 */
export { tool as defineTool } from 'ai';
