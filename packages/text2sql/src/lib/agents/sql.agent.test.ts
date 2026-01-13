import { APICallError } from '@ai-sdk/provider';
import { MockLanguageModelV2 } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { init_db } from '../../tests/sqlite.ts';
import {
  SQLValidationError,
  UnanswerableSQLError,
  toSql,
} from './sql.agent.ts';

type MockModelResponse =
  | { sql: string; reasoning?: string }
  | { error: string };

/** Helper to create a MockLanguageModelV2 that returns a structured response */
function createMockModel(response: MockModelResponse) {
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      content: [{ type: 'text', text: JSON.stringify(response) }],
      warnings: [],
    }),
  });
}

/** Helper to create a MockLanguageModelV2 that throws an error */
function createThrowingModel(errorFactory: () => Error) {
  return new MockLanguageModelV2({
    doGenerate: async () => {
      throw errorFactory();
    },
  });
}

/** Helper to create a model that captures call metadata */
function createCapturingModel(responses: Array<MockModelResponse | Error>) {
  const calls: Array<{ messages: unknown; settings: unknown }> = [];
  let callIndex = 0;
  return {
    calls,
    model: new MockLanguageModelV2({
      doGenerate: async (options) => {
        calls.push({ messages: options.prompt, settings: options });
        const response = responses[callIndex++];
        if (response instanceof Error) {
          throw response;
        }
        return {
          finishReason: 'stop' as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          content: [{ type: 'text' as const, text: JSON.stringify(response) }],
          warnings: [],
        };
      },
    }),
  };
}

describe('toSql', () => {
  it('returns SQL on first attempt success', async () => {
    // Arrange
    const { adapter } = await init_db('', { validate: () => undefined });
    const model = createMockModel({ sql: 'SELECT 1' });

    // Act
    const result = await toSql({
      input: 'query',
      adapter,
      schemaFragments: [],
      instructions: [],
      model,
    });

    // Assert
    assert.strictEqual(result.sql, 'SELECT 1');
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(result.errors, undefined);
  });

  it('retries on SQL validation error and passes previousError to model', async () => {
    // Arrange
    const validateResponses = ['syntax error', undefined];
    const { adapter } = await init_db('', {
      validate: () => validateResponses.shift(),
    });
    const { model, calls } = createCapturingModel([
      { sql: 'SELECT 1' },
      { sql: 'SELECT 1' },
    ]);

    // Act
    const result = await toSql({
      input: 'query',
      adapter,
      schemaFragments: [],
      instructions: [],
      model,
    });

    // Assert
    assert.strictEqual(result.sql, 'SELECT 1');
    assert.strictEqual(result.attempts, 2);
    assert.deepStrictEqual(result.errors, [
      'SQL Validation Error: syntax error',
    ]);

    assert.strictEqual(calls.length, 2);
    const secondCallMessages = JSON.stringify(calls[1].messages);
    assert.ok(
      secondCallMessages.includes('syntax error'),
      'Second call should include previous error in prompt',
    );
  });

  it('retries on JSON validation error', async () => {
    // Arrange
    const { adapter } = await init_db('', { validate: () => undefined });
    let callCount = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          throw new APICallError({
            message: 'Failed to validate JSON',
            url: 'https://api.test.com',
            requestBodyValues: {},
            isRetryable: false,
          });
        }
        return {
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          content: [
            { type: 'text', text: JSON.stringify({ sql: 'SELECT 1' }) },
          ],
          warnings: [],
        };
      },
    });

    // Act
    const result = await toSql({
      input: 'query',
      adapter,
      schemaFragments: [],
      instructions: [],
      model,
    });

    // Assert
    assert.strictEqual(result.sql, 'SELECT 1');
    assert.strictEqual(result.attempts, 2, '');
    assert.ok(result.errors?.[0]?.includes('Schema validation failed'));
  });

  it('throws SQLValidationError when retries exhausted', async () => {
    // Arrange
    const validateResponses = ['error', 'error', 'error'];
    const { adapter } = await init_db('', {
      validate: () => validateResponses.shift(),
    });
    const model = createMockModel({ sql: 'SELECT 1' });

    // Act & Assert
    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          schemaFragments: [],
          instructions: [],
          model,
        }),
      SQLValidationError.isInstance,
    );
  });

  it('throws SQLValidationError after exhausting custom maxRetries', async () => {
    // Arrange
    const validateResponses = ['error', 'error', 'error', 'error', 'error'];
    const { adapter } = await init_db('', {
      validate: () => validateResponses.shift(),
    });
    const model = createMockModel({ sql: 'SELECT 1' });

    // Act & Assert
    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          schemaFragments: [],
          instructions: [],
          model,
          maxRetries: 5,
        }),
      (error) => {
        assert(SQLValidationError.isInstance(error));
        return true;
      },
    );
  });

  it('throws TypeError when maxRetries is 0 (invalid for p-retry)', async () => {
    const { adapter } = await init_db('', { validate: () => 'error' });
    const model = createMockModel({ sql: 'SELECT 1' });

    // Act & Assert
    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          schemaFragments: [],
          instructions: [],
          model,
          maxRetries: 0,
        }),
      (error) => {
        assert(error instanceof TypeError);
        return true;
      },
    );
  });

  it('throws SQLValidationError after single attempt when maxRetries is 1', async () => {
    const { adapter } = await init_db('', {
      validate: () => 'validation error',
    });
    const model = createMockModel({ sql: 'SELECT 1' });

    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          schemaFragments: [],
          instructions: [],
          model,
          maxRetries: 1,
        }),
      (error) => {
        assert(SQLValidationError.isInstance(error));
        assert(error.message === 'validation error');
        return true;
      },
    );
  });

  it('uses fallback temperature when maxRetries exceeds RETRY_TEMPERATURES length', async () => {
    const validateResponses = ['e1', 'e2', 'e3', 'e4', 'e5', undefined];
    const { adapter } = await init_db('', {
      validate: () => validateResponses.shift(),
    });

    const { model, calls } = createCapturingModel([
      { sql: 'SELECT 1' }, // attempt 1
      { sql: 'SELECT 1' }, // attempt 2
      { sql: 'SELECT 1' }, // attempt 3
      { sql: 'SELECT 1' }, // attempt 4
      { sql: 'SELECT 1' }, // attempt 5
      { sql: 'SELECT 1' }, // attempt 6 - succeeds
    ]);

    const result = await toSql({
      input: 'query',
      adapter,
      schemaFragments: [],
      instructions: [],
      model,
      maxRetries: 6,
    });

    assert.strictEqual(result.sql, 'SELECT 1');
    assert.strictEqual(result.attempts, 6);
    assert.strictEqual(result.errors?.length, 5);
    assert.strictEqual(calls.length, 6);
    const expectedTemperatures = [0, 0.2, 0.3, 0.3, 0.3, 0.3];

    for (let i = 0; i < calls.length; i++) {
      const settings = calls[i].settings as { temperature?: number };
      assert.strictEqual(
        settings.temperature,
        expectedTemperatures[i],
        `Attempt ${i + 1} should use temperature ${expectedTemperatures[i]}`,
      );
    }
  });

  it('handles mixed error types', async () => {
    // Arrange
    const validateResponses = ['SQL error', undefined];
    const { adapter } = await init_db('', {
      validate: () => validateResponses.shift(),
    });
    let callCount = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          throw new APICallError({
            message: 'Failed to validate JSON',
            url: 'https://api.test.com',
            requestBodyValues: {},
            isRetryable: false,
          });
        }
        return {
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          content: [
            { type: 'text', text: JSON.stringify({ sql: 'SELECT 1' }) },
          ],
          warnings: [],
        };
      },
    });

    // Act
    const result = await toSql({
      input: 'query',
      adapter,
      schemaFragments: [],
      instructions: [],
      model,
    });

    // Assert
    assert.strictEqual(result.attempts, 3);
    assert.strictEqual(result.errors?.length, 2);
  });

  it('throws UnanswerableSQLError immediately when question is unanswerable', async () => {
    // Arrange
    const { adapter } = await init_db('');
    const model = createMockModel({ error: 'No matching table' });

    // Act & Assert
    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          schemaFragments: [],
          instructions: [],
          model,
          maxRetries: 3,
        }),
      (error) => {
        assert(UnanswerableSQLError.isInstance(error));
        assert(error.message === 'No matching table');
        return true;
      },
    );
  });

  it('throws APICallError on json_validate_failed error', async () => {
    // Arrange
    const { adapter } = await init_db('');
    const model = createThrowingModel(
      () =>
        new APICallError({
          message:
            "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
          url: 'https://api.groq.com/openai/v1/chat/completions',
          requestBodyValues: {},
          statusCode: 400,
          responseBody:
            '{"error":{"message":"Failed to validate JSON...","type":"invalid_request_error","code":"json_validate_failed"}}',
          isRetryable: false,
        }),
    );

    // Act & Assert
    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          schemaFragments: [],
          instructions: [],
          model,
          maxRetries: 1,
        }),
      (error) => {
        assert(APICallError.isInstance(error));
        assert(error.message.includes('Failed to validate JSON'));
        return true;
      },
    );
  });

  it('throws APICallError on response schema mismatch error', async () => {
    // Arrange
    const { adapter } = await init_db('');
    const model = createThrowingModel(
      () =>
        new APICallError({
          message: 'response did not match schema',
          url: 'https://api.groq.com/openai/v1/chat/completions',
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        }),
    );

    // Act & Assert
    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          schemaFragments: [],
          instructions: [],
          model,
          maxRetries: 1,
        }),
      (error) => {
        assert(APICallError.isInstance(error));
        assert(error.message.includes('response did not match schema'));
        return true;
      },
    );
  });

  it('rethrows non-JSON-validation errors', async () => {
    // Arrange
    const { adapter } = await init_db('');
    const model = createThrowingModel(() => new Error('Network timeout'));

    // Act & Assert
    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          schemaFragments: [],
          instructions: [],
          model,
        }),
      /Network timeout/,
    );
  });

  it('extracts SQL from markdown code block in response', async () => {
    const { adapter } = await init_db('', { validate: () => undefined });

    const testCases = [
      {
        input: '```sql\nSELECT * FROM users\n```',
        expected: 'SELECT * FROM users',
        name: 'standard sql block',
      },
      {
        input: '```SQL\nSELECT * FROM users\n```',
        expected: '```SQL\nSELECT * FROM users\n```',
        name: 'uppercase SQL (not extracted - case sensitive)',
      },
      {
        input: '```\nSELECT * FROM users\n```',
        expected: '```\nSELECT * FROM users\n```',
        name: 'no language specifier (not extracted)',
      },
      {
        input: '```sql\nSELECT 1\n```\ntext\n```sql\nSELECT 2\n```',
        expected: 'SELECT 1',
        name: 'multiple blocks (first extracted)',
      },
      {
        input: 'SELECT `column` FROM `table`',
        expected: 'SELECT `column` FROM `table`',
        name: 'backticks in query (no code block)',
      },
    ];

    for (const { input, expected, name } of testCases) {
      const model = createMockModel({ sql: input });
      const result = await toSql({
        input: 'query',
        adapter,
        schemaFragments: [],
        instructions: [],
        model,
        maxRetries: 1,
      });
      assert.strictEqual(result.sql, expected, `Failed for case: ${name}`);
    }
  });

  it('returns plain SQL unchanged', async () => {
    // Arrange
    const { adapter } = await init_db('');
    const model = createMockModel({ sql: 'SELECT 1' });

    // Act
    const result = await toSql({
      input: 'query',
      adapter,
      schemaFragments: [],
      instructions: [],
      model,
      maxRetries: 1,
    });

    // Assert
    assert.strictEqual(result.sql, 'SELECT 1');
  });

  describe('previous error injection', () => {
    it('does not include validation_error on first attempt', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([{ sql: 'SELECT 1' }]);

      await toSql({
        input: 'query',
        adapter,
        schemaFragments: [],
        instructions: [],
        model,
        maxRetries: 1,
      });

      assert.strictEqual(calls.length, 1);
      const firstCallMessages = JSON.stringify(calls[0].messages);
      assert.ok(
        !firstCallMessages.includes('validation_error'),
        'First call should not include validation_error block',
      );
    });
  });

  describe('output schema handling', () => {
    it('handles response with reasoning field', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const model = createMockModel({
        sql: 'SELECT * FROM users',
        reasoning: 'The user wants all columns from the users table',
      });

      const result = await toSql({
        input: 'query',
        adapter,
        schemaFragments: [],
        instructions: [],
        model,
        maxRetries: 1,
      });

      assert.strictEqual(result.sql, 'SELECT * FROM users');
      assert.strictEqual(result.attempts, 1);
    });

    it('handles empty sql string in response', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const model = createMockModel({ sql: '' });

      const result = await toSql({
        input: 'query',
        adapter,
        schemaFragments: [],
        instructions: [],
        model,
        maxRetries: 1,
      });

      assert.strictEqual(result.sql, '');
      assert.strictEqual(result.attempts, 1);
    });
  });

  describe('adapter error handling', () => {
    it('throws SQLValidationError when adapter.validate throws an exception', async () => {
      const { adapter } = await init_db('', {
        validate: () => {
          throw new Error('Database connection lost');
        },
      });
      const model = createMockModel({ sql: 'SELECT 1' });

      await assert.rejects(
        () =>
          toSql({
            input: 'query',
            adapter,
            schemaFragments: [],
            instructions: [],
            model,
            maxRetries: 1,
          }),
        (error) => {
          assert(SQLValidationError.isInstance(error));
          assert(error.message.includes('Database connection lost'));
          return true;
        },
      );
    });

    it('handles adapter.validate returning undefined', async () => {
      const { adapter } = await init_db('', {
        validate: () => undefined,
      });
      const model = createMockModel({ sql: 'SELECT 1' });

      const result = await toSql({
        input: 'query',
        adapter,
        schemaFragments: [],
        instructions: [],
        model,
        maxRetries: 1,
      });

      assert.strictEqual(result.sql, 'SELECT 1');
      assert.strictEqual(result.attempts, 1);
    });
  });

  describe('input edge cases', () => {
    it('handles empty input string', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const model = createMockModel({ sql: 'SELECT 1' });

      const result = await toSql({
        input: '',
        adapter,
        schemaFragments: [],
        instructions: [],
        model,
        maxRetries: 1,
      });

      assert.strictEqual(result.sql, 'SELECT 1');
      assert.strictEqual(result.attempts, 1);
    });

    it('handles input with special characters', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([
        { sql: 'SELECT email FROM users' },
      ]);
      const inputWithSpecialChars =
        "What's the user's email? (test@example.com)";

      const result = await toSql({
        input: inputWithSpecialChars,
        adapter,
        schemaFragments: [],
        instructions: [],
        model,
        maxRetries: 1,
      });

      assert.strictEqual(result.sql, 'SELECT email FROM users');
      const promptContent = JSON.stringify(calls[0].messages);
      assert.ok(promptContent.includes("What's the user's email?"));
    });

    it('handles very long input', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const model = createMockModel({ sql: 'SELECT 1' });
      const longInput = 'a'.repeat(10000);

      const result = await toSql({
        input: longInput,
        adapter,
        schemaFragments: [],
        instructions: [],
        model,
        maxRetries: 1,
      });

      assert.strictEqual(result.sql, 'SELECT 1');
      assert.strictEqual(result.attempts, 1);
    });
  });

  describe('concurrency and isolation', () => {
    it('handles concurrent toSql calls independently', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });

      const model1 = createMockModel({ sql: 'SELECT 1' });
      const model2 = createMockModel({ sql: 'SELECT 2' });
      const model3 = createMockModel({ sql: 'SELECT 3' });

      const [result1, result2, result3] = await Promise.all([
        toSql({
          input: 'query 1',
          adapter,
          schemaFragments: [],
          instructions: [],
          model: model1,
          maxRetries: 1,
        }),
        toSql({
          input: 'query 2',
          adapter,
          schemaFragments: [],
          instructions: [],
          model: model2,
          maxRetries: 1,
        }),
        toSql({
          input: 'query 3',
          adapter,
          schemaFragments: [],
          instructions: [],
          model: model3,
          maxRetries: 1,
        }),
      ]);

      assert.strictEqual(result1.sql, 'SELECT 1');
      assert.strictEqual(result2.sql, 'SELECT 2');
      assert.strictEqual(result3.sql, 'SELECT 3');
    });
  });
});
