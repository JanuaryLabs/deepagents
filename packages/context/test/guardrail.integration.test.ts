import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type Guardrail,
  errorRecoveryGuardrail,
  fail,
  pass,
  runGuardrailChain,
  stop,
} from '@deepagents/context';

describe('Guardrail System', () => {
  describe('runGuardrailChain', () => {
    it('should pass through non-error parts unchanged', () => {
      const textDeltaPart = {
        type: 'text-delta' as const,
        id: 'part-1',
        delta: 'Hello world',
      };

      const result = runGuardrailChain(
        textDeltaPart,
        [errorRecoveryGuardrail],
        { availableTools: ['bash', 'sql'], availableSkills: [] },
      );

      assert.strictEqual(result.type, 'pass');
      assert.deepStrictEqual(result.part, textDeltaPart);
    });

    it('should trigger on error parts', () => {
      const errorPart = {
        type: 'error' as const,
        errorText: 'Tool choice is none, but model called a tool',
      };

      const result = runGuardrailChain(errorPart, [errorRecoveryGuardrail], {
        availableTools: ['bash', 'sql'],
        availableSkills: [],
      });

      assert.strictEqual(result.type, 'fail');
      assert.ok(result.feedback.includes('Available tools: bash, sql'));
    });

    it('should handle tool not found errors', () => {
      const errorPart = {
        type: 'error' as const,
        errorText:
          "attempted to call tool 'unknown_tool' which was not in request.tools",
      };

      const result = runGuardrailChain(errorPart, [errorRecoveryGuardrail], {
        availableTools: ['bash'],
        availableSkills: [],
      });

      assert.strictEqual(result.type, 'fail');
      assert.ok(result.feedback.includes('unknown_tool'));
      assert.ok(result.feedback.includes('Available tools: bash'));
    });

    it('should handle malformed JSON errors', () => {
      const errorPart = {
        type: 'error' as const,
        errorText: 'Failed to parse tool call arguments as JSON',
      };

      const result = runGuardrailChain(errorPart, [errorRecoveryGuardrail], {
        availableTools: [],
        availableSkills: [],
      });

      assert.strictEqual(result.type, 'fail');
      assert.ok(result.feedback.includes('malformed JSON'));
    });

    it('should handle parsing failed errors', () => {
      const errorPart = {
        type: 'error' as const,
        errorText: 'Parsing failed due to invalid syntax',
      };

      const result = runGuardrailChain(errorPart, [errorRecoveryGuardrail], {
        availableTools: [],
        availableSkills: [],
      });

      assert.strictEqual(result.type, 'fail');
      assert.ok(result.feedback.includes('invalid'));
    });

    it('should handle tool schema validation errors', () => {
      const errorPart = {
        type: 'error' as const,
        errorText:
          'Tool call validation failed: tool call validation failed: parameters for tool render_ask_user_question did not match schema: errors: [`/questions/0/type`: value must be "free_form", `/questions/0`: additionalProperties \'options\' not allowed, `/questions/0/options`: maximum 5 items required, but found 6 items]',
      };

      const result = runGuardrailChain(errorPart, [errorRecoveryGuardrail], {
        availableTools: ['render_ask_user_question'],
        availableSkills: [],
      });

      assert.strictEqual(result.type, 'fail');
      assert.ok(result.feedback.includes('render_ask_user_question'));
      assert.ok(result.feedback.includes('invalid parameters'));
    });

    it('should stop on unknown errors without retry', () => {
      const errorPart = {
        type: 'error' as const,
        errorText: 'Some random unknown error occurred',
      };

      const result = runGuardrailChain(errorPart, [errorRecoveryGuardrail], {
        availableTools: [],
        availableSkills: [],
      });

      assert.strictEqual(result.type, 'stop');
      assert.deepStrictEqual(result.part, errorPart);
    });
  });

  describe('Custom Guardrails', () => {
    it('should support custom guardrail that passes', () => {
      const customGuardrail: Guardrail = {
        id: 'custom-pass',
        name: 'Always Pass',
        handle: (part) => pass(part),
      };

      const textPart = { type: 'text-delta' as const, id: 'p1', delta: 'test' };
      const result = runGuardrailChain(textPart, [customGuardrail], {
        availableTools: [],
        availableSkills: [],
      });

      assert.strictEqual(result.type, 'pass');
    });

    it('should support custom guardrail that fails', () => {
      const customGuardrail: Guardrail = {
        id: 'custom-fail',
        name: 'Always Fail',
        handle: (part) => {
          if (
            part.type === 'text-delta' &&
            (part as { delta: string }).delta.includes('bad')
          ) {
            return fail('Found bad word');
          }
          return pass(part);
        },
      };

      const goodPart = {
        type: 'text-delta' as const,
        id: 'p1',
        delta: 'good text',
      };
      const badPart = {
        type: 'text-delta' as const,
        id: 'p2',
        delta: 'bad text',
      };

      const goodResult = runGuardrailChain(goodPart, [customGuardrail], {
        availableTools: [],
        availableSkills: [],
      });
      const badResult = runGuardrailChain(badPart, [customGuardrail], {
        availableTools: [],
        availableSkills: [],
      });

      assert.strictEqual(goodResult.type, 'pass');
      assert.strictEqual(badResult.type, 'fail');
      assert.strictEqual(badResult.feedback, 'Found bad word');
    });

    it('should run guardrails in chain order', () => {
      const callOrder: string[] = [];

      const guardrail1: Guardrail = {
        id: 'g1',
        name: 'First',
        handle: (part) => {
          callOrder.push('g1');
          return pass(part);
        },
      };

      const guardrail2: Guardrail = {
        id: 'g2',
        name: 'Second',
        handle: (part) => {
          callOrder.push('g2');
          return pass(part);
        },
      };

      const part = { type: 'text-delta' as const, id: 'p1', delta: 'test' };
      runGuardrailChain(part, [guardrail1, guardrail2], {
        availableTools: [],
        availableSkills: [],
      });

      assert.deepStrictEqual(callOrder, ['g1', 'g2']);
    });

    it('should stop chain on first failure', () => {
      const callOrder: string[] = [];

      const failingGuardrail: Guardrail = {
        id: 'failing',
        name: 'Fails',
        handle: (part) => {
          callOrder.push('failing');
          return fail('Stop here');
        },
      };

      const neverCalledGuardrail: Guardrail = {
        id: 'never-called',
        name: 'Never Called',
        handle: (part) => {
          callOrder.push('never-called');
          return pass(part);
        },
      };

      const part = { type: 'text-delta' as const, id: 'p1', delta: 'test' };
      const result = runGuardrailChain(
        part,
        [failingGuardrail, neverCalledGuardrail],
        { availableTools: [], availableSkills: [] },
      );

      assert.strictEqual(result.type, 'fail');
      assert.deepStrictEqual(callOrder, ['failing']);
    });

    it('should stop chain on stop result', () => {
      const callOrder: string[] = [];

      const stoppingGuardrail: Guardrail = {
        id: 'stopping',
        name: 'Stops',
        handle: (part) => {
          callOrder.push('stopping');
          return stop(part);
        },
      };

      const neverCalledGuardrail: Guardrail = {
        id: 'never-called',
        name: 'Never Called',
        handle: (part) => {
          callOrder.push('never-called');
          return pass(part);
        },
      };

      const part = { type: 'error' as const, errorText: 'Some error' };
      const result = runGuardrailChain(
        part,
        [stoppingGuardrail, neverCalledGuardrail],
        { availableTools: [], availableSkills: [] },
      );

      assert.strictEqual(result.type, 'stop');
      assert.deepStrictEqual(result.part, part);
      assert.deepStrictEqual(callOrder, ['stopping']);
    });

    it('should support custom guardrail that stops', () => {
      const customGuardrail: Guardrail = {
        id: 'custom-stop',
        name: 'Stop on Error',
        handle: (part) => {
          if (part.type === 'error') {
            return stop(part);
          }
          return pass(part);
        },
      };

      const textPart = { type: 'text-delta' as const, id: 'p1', delta: 'test' };
      const errorPart = { type: 'error' as const, errorText: 'Unrecoverable' };

      const textResult = runGuardrailChain(textPart, [customGuardrail], {
        availableTools: [],
        availableSkills: [],
      });
      const errorResult = runGuardrailChain(errorPart, [customGuardrail], {
        availableTools: [],
        availableSkills: [],
      });

      assert.strictEqual(textResult.type, 'pass');
      assert.strictEqual(errorResult.type, 'stop');
      assert.deepStrictEqual(errorResult.part, errorPart);
    });
  });

  describe('Error Recovery Guardrail Edge Cases', () => {
    it('should handle no tools available gracefully', () => {
      const errorPart = {
        type: 'error' as const,
        errorText: 'Tool choice is none',
      };

      const result = runGuardrailChain(errorPart, [errorRecoveryGuardrail], {
        availableTools: [],
        availableSkills: [],
      });

      assert.strictEqual(result.type, 'fail');
      assert.ok(result.feedback.includes('no tools are available'));
    });

    it('should stop on empty error text (unknown error)', () => {
      const errorPart = {
        type: 'error' as const,
        errorText: '',
      };

      const result = runGuardrailChain(errorPart, [errorRecoveryGuardrail], {
        availableTools: ['bash'],
        availableSkills: [],
      });

      // Empty error text is unknown - should stop without retry
      assert.strictEqual(result.type, 'stop');
      assert.deepStrictEqual(result.part, errorPart);
    });
  });

  describe('lastAssistantMessage Lazy Fragment', () => {
    it('should handle lastAssistantMessage in save() without encode error', async () => {
      const { ContextEngine, InMemoryContextStore, lastAssistantMessage } =
        await import('@deepagents/context');

      const store = new InMemoryContextStore();
      const context = new ContextEngine({
        userId: 'test-user',
        chatId: 'test-chat',
        store,
      });

      // Simulate guardrail retry: set lastAssistantMessage and save
      context.set(
        lastAssistantMessage(
          'I tried something but it failed. Let me try again.',
        ),
      );

      // This should NOT throw "Cannot read properties of undefined (reading 'encode')"
      await context.save();
    });
  });
});
