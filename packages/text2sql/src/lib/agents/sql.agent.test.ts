import {
  APICallError,
  JSONParseError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  TypeValidationError,
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { fragment } from '@deepagents/context';
import {
  SQLValidationError,
  UnanswerableSQLError,
  toSql,
} from '@deepagents/text2sql';

import { init_db } from '../../tests/sqlite.ts';

type MockModelResponse =
  | { result: { sql: string; reasoning: string } }
  | { result: { error: string } };
const testUsage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 10,
    text: 10,
    reasoning: undefined,
  },
} as const;
/** Helper to create a MockLanguageModelV3 that returns a structured response */
function createMockModel(response: MockModelResponse) {
  return new MockLanguageModelV3({
    doGenerate: {
      finishReason: { unified: 'stop', raw: '' },
      usage: testUsage,
      content: [{ type: 'text', text: JSON.stringify(response) }],
      warnings: [],
    },
  });
}

/** Helper to create a MockLanguageModelV3 that throws an error */
function createThrowingModel(errorFactory: () => Error) {
  return new MockLanguageModelV3({
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
    model: new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push({ messages: options.prompt, settings: options });
        const response = responses[callIndex++];
        if (response instanceof Error) {
          throw response;
        }
        return {
          finishReason: { unified: 'stop', raw: '' },
          usage: testUsage,
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
    const model = createMockModel({
      result: { sql: 'SELECT 1', reasoning: 'test' },
    });

    // Act
    const result = await toSql({
      input: 'query',
      adapter,
      fragments: [],
      model,
    });

    // Assert
    assert.strictEqual(result.sql, adapter.format('SELECT 1'));
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
      { result: { sql: 'SELECT 1', reasoning: 'test' } },
      { result: { sql: 'SELECT 1', reasoning: 'test' } },
    ]);

    // Act
    const result = await toSql({
      input: 'query',
      adapter,
      fragments: [],
      model,
    });

    // Assert
    assert.strictEqual(result.sql, adapter.format('SELECT 1'));
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
    const model = new MockLanguageModelV3({
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
          finishReason: { unified: 'stop', raw: '' },
          usage: testUsage,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                result: { sql: 'SELECT 1', reasoning: 'test' },
              }),
            },
          ],
          warnings: [],
        };
      },
    });

    // Act
    const result = await toSql({
      input: 'query',
      adapter,
      fragments: [],
      model,
    });

    // Assert
    assert.strictEqual(result.sql, adapter.format('SELECT 1'));
    assert.strictEqual(result.attempts, 2, '');
    assert.ok(result.errors?.[0]?.includes('Schema validation failed'));
  });

  it('does not retry when model is not found', async () => {
    const { adapter } = await init_db('', { validate: () => undefined });
    let attempts = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        attempts += 1;
        throw new APICallError({
          message:
            'The model `gpt-oss-20b` does not exist or you do not have access to it.',
          url: 'https://api.groq.com/openai/v1/chat/completions',
          requestBodyValues: {},
          statusCode: 404,
          responseBody:
            '{"error":{"message":"The model `gpt-oss-20b` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}',
          isRetryable: false,
        });
      },
    });

    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          fragments: [],
          model,
          maxRetries: 3,
        }),
      (error) => {
        assert(APICallError.isInstance(error));
        assert(
          error.message.includes('does not exist or you do not have access'),
        );
        return true;
      },
    );

    assert.strictEqual(attempts, 1);
  });

  it('throws SQLValidationError when retries exhausted', async () => {
    // Arrange
    const validateResponses = ['error', 'error', 'error'];
    const { adapter } = await init_db('', {
      validate: () => validateResponses.shift(),
    });
    const model = createMockModel({
      result: { sql: 'SELECT 1', reasoning: 'test' },
    });

    // Act & Assert
    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          fragments: [],
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
    const model = createMockModel({
      result: { sql: 'SELECT 1', reasoning: 'test' },
    });

    // Act & Assert
    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          fragments: [],
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
    const model = createMockModel({
      result: { sql: 'SELECT 1', reasoning: 'test' },
    });

    // Act & Assert
    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          fragments: [],
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
    const model = createMockModel({
      result: { sql: 'SELECT 1', reasoning: 'test' },
    });

    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          fragments: [],
          model,
          maxRetries: 1,
        }),
      (error) => {
        assert(SQLValidationError.isInstance(error));
        assert((error as SQLValidationError).message === 'validation error');
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
      { result: { sql: 'SELECT 1', reasoning: 'test' } }, // attempt 1
      { result: { sql: 'SELECT 1', reasoning: 'test' } }, // attempt 2
      { result: { sql: 'SELECT 1', reasoning: 'test' } }, // attempt 3
      { result: { sql: 'SELECT 1', reasoning: 'test' } }, // attempt 4
      { result: { sql: 'SELECT 1', reasoning: 'test' } }, // attempt 5
      { result: { sql: 'SELECT 1', reasoning: 'test' } }, // attempt 6 - succeeds
    ]);

    const result = await toSql({
      input: 'query',
      adapter,
      fragments: [],
      model,
      maxRetries: 6,
    });

    assert.strictEqual(result.sql, adapter.format('SELECT 1'));
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
    const model = new MockLanguageModelV3({
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
          finishReason: { unified: 'stop', raw: '' },
          usage: testUsage,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                result: { sql: 'SELECT 1', reasoning: 'test' },
              }),
            },
          ],
          warnings: [],
        };
      },
    });

    // Act
    const result = await toSql({
      input: 'query',
      adapter,
      fragments: [],
      model,
    });

    // Assert
    assert.strictEqual(result.attempts, 3);
    assert.strictEqual(result.errors?.length, 2);
  });

  it('throws UnanswerableSQLError immediately when question is unanswerable', async () => {
    // Arrange
    const { adapter } = await init_db('');
    const model = createMockModel({ result: { error: 'No matching table' } });

    // Act & Assert
    await assert.rejects(
      () =>
        toSql({
          input: 'query',
          adapter,
          fragments: [],
          model,
          maxRetries: 3,
        }),
      (error) => {
        assert(UnanswerableSQLError.isInstance(error));
        assert((error as UnanswerableSQLError).message === 'No matching table');
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
          fragments: [],
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
          fragments: [],
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
          fragments: [],
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
        expected: adapter.format('SELECT * FROM users'),
        name: 'standard sql block',
      },
      {
        input: '```SQL\nSELECT * FROM users\n```',
        expected: adapter.format('```SQL\nSELECT * FROM users\n```'),
        name: 'uppercase SQL (not extracted - case sensitive)',
      },
      {
        input: '```\nSELECT * FROM users\n```',
        expected: adapter.format('```\nSELECT * FROM users\n```'),
        name: 'no language specifier (not extracted)',
      },
      {
        input: '```sql\nSELECT 1\n```\ntext\n```sql\nSELECT 2\n```',
        expected: adapter.format('SELECT 1'),
        name: 'multiple blocks (first extracted)',
      },
      {
        input: 'SELECT `column` FROM `table`',
        expected: adapter.format('SELECT `column` FROM `table`'),
        name: 'backticks in query (no code block)',
      },
    ];

    for (const { input, expected, name } of testCases) {
      const model = createMockModel({
        result: { sql: input, reasoning: 'test' },
      });
      const result = await toSql({
        input: 'query',
        adapter,
        fragments: [],
        model,
        maxRetries: 1,
      });
      assert.strictEqual(result.sql, expected, `Failed for case: ${name}`);
    }
  });

  it('returns formatted SQL', async () => {
    // Arrange
    const { adapter } = await init_db('');
    const model = createMockModel({
      result: { sql: 'SELECT 1', reasoning: 'test' },
    });

    // Act
    const result = await toSql({
      input: 'query',
      adapter,
      fragments: [],
      model,
      maxRetries: 1,
    });

    // Assert
    assert.strictEqual(result.sql, adapter.format('SELECT 1'));
  });

  describe('previous error injection', () => {
    it('does not include validation_error on first attempt', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([
        { result: { sql: 'SELECT 1', reasoning: 'test' } },
      ]);

      await toSql({
        input: 'query',
        adapter,
        fragments: [],
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
        result: {
          sql: 'SELECT * FROM users',
          reasoning: 'The user wants all columns from the users table',
        },
      });

      const result = await toSql({
        input: 'query',
        adapter,
        fragments: [],
        model,
        maxRetries: 1,
      });

      assert.strictEqual(result.sql, adapter.format('SELECT * FROM users'));
      assert.strictEqual(result.attempts, 1);
    });

    it('handles empty sql string in response', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const model = createMockModel({ result: { sql: '', reasoning: 'test' } });

      const result = await toSql({
        input: 'query',
        adapter,
        fragments: [],
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
      const model = createMockModel({
        result: { sql: 'SELECT 1', reasoning: 'test' },
      });

      await assert.rejects(
        () =>
          toSql({
            input: 'query',
            adapter,
            fragments: [],
            model,
            maxRetries: 1,
          }),
        (error) => {
          assert(SQLValidationError.isInstance(error));
          assert(
            (error as SQLValidationError).message.includes(
              'Database connection lost',
            ),
          );
          return true;
        },
      );
    });

    it('handles adapter.validate returning undefined', async () => {
      const { adapter } = await init_db('', {
        validate: () => undefined,
      });
      const model = createMockModel({
        result: { sql: 'SELECT 1', reasoning: 'test' },
      });

      const result = await toSql({
        input: 'query',
        adapter,
        fragments: [],
        model,
        maxRetries: 1,
      });

      assert.strictEqual(result.sql, adapter.format('SELECT 1'));
      assert.strictEqual(result.attempts, 1);
    });
  });

  describe('input edge cases', () => {
    it('handles empty input string', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const model = createMockModel({
        result: { sql: 'SELECT 1', reasoning: 'test' },
      });

      const result = await toSql({
        input: '',
        adapter,
        fragments: [],
        model,
        maxRetries: 1,
      });

      assert.strictEqual(result.sql, adapter.format('SELECT 1'));
      assert.strictEqual(result.attempts, 1);
    });

    it('handles input with special characters', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([
        { result: { sql: 'SELECT email FROM users', reasoning: 'test' } },
      ]);
      const inputWithSpecialChars =
        "What's the user's email? (test@example.com)";

      const result = await toSql({
        input: inputWithSpecialChars,
        adapter,
        fragments: [],
        model,
        maxRetries: 1,
      });

      assert.strictEqual(result.sql, adapter.format('SELECT email FROM users'));
      const promptContent = JSON.stringify(calls[0].messages);
      assert.ok(promptContent.includes("What's the user's email?"));
    });

    it('handles very long input', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const model = createMockModel({
        result: { sql: 'SELECT 1', reasoning: 'test' },
      });
      const longInput = 'a'.repeat(10000);

      const result = await toSql({
        input: longInput,
        adapter,
        fragments: [],
        model,
        maxRetries: 1,
      });

      assert.strictEqual(result.sql, adapter.format('SELECT 1'));
      assert.strictEqual(result.attempts, 1);
    });
  });

  describe('concurrency and isolation', () => {
    it('handles concurrent toSql calls independently', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });

      const model1 = createMockModel({
        result: { sql: 'SELECT 1', reasoning: 'test' },
      });
      const model2 = createMockModel({
        result: { sql: 'SELECT 2', reasoning: 'test' },
      });
      const model3 = createMockModel({
        result: { sql: 'SELECT 3', reasoning: 'test' },
      });

      const [result1, result2, result3] = await Promise.all([
        toSql({
          input: 'query 1',
          adapter,
          fragments: [],
          model: model1,
          maxRetries: 1,
        }),
        toSql({
          input: 'query 2',
          adapter,
          fragments: [],
          model: model2,
          maxRetries: 1,
        }),
        toSql({
          input: 'query 3',
          adapter,
          fragments: [],
          model: model3,
          maxRetries: 1,
        }),
      ]);

      assert.strictEqual(result1.sql, adapter.format('SELECT 1'));
      assert.strictEqual(result2.sql, adapter.format('SELECT 2'));
      assert.strictEqual(result3.sql, adapter.format('SELECT 3'));
    });
  });

  describe('retryable AI SDK errors', () => {
    it('retries on JSONParseError and succeeds on next attempt', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([
        new JSONParseError({
          text: '{ bad json',
          cause: new SyntaxError('Unexpected token'),
        }),
        { result: { sql: 'SELECT 1', reasoning: 'test' } },
      ]);

      const result = await toSql({
        input: 'query',
        adapter,
        fragments: [],
        model,
      });

      assert.strictEqual(result.sql, adapter.format('SELECT 1'));
      assert.strictEqual(result.attempts, 2);
      assert.strictEqual(result.errors?.length, 1);
      assert.strictEqual(calls.length, 2);
    });

    it('retries on TypeValidationError and succeeds on next attempt', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([
        new TypeValidationError({
          value: { invalid: true },
          cause: new Error('Expected string, got number'),
        }),
        { result: { sql: 'SELECT 1', reasoning: 'test' } },
      ]);

      const result = await toSql({
        input: 'query',
        adapter,
        fragments: [],
        model,
      });

      assert.strictEqual(result.sql, adapter.format('SELECT 1'));
      assert.strictEqual(result.attempts, 2);
      assert.strictEqual(result.errors?.length, 1);
      assert.strictEqual(calls.length, 2);
    });

    it('retries on NoObjectGeneratedError and succeeds on next attempt', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([
        new NoObjectGeneratedError({
          response: { id: 'r1', timestamp: new Date(), modelId: 'test' },
          usage: {
            inputTokens: 10,
            inputTokenDetails: {
              noCacheTokens: 10,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            outputTokens: 0,
            outputTokenDetails: {
              textTokens: 0,
              reasoningTokens: 0,
            },
            totalTokens: 10,
          },
          finishReason: 'error',
        }),
        { result: { sql: 'SELECT 1', reasoning: 'test' } },
      ]);

      const result = await toSql({
        input: 'query',
        adapter,
        fragments: [],
        model,
      });

      assert.strictEqual(result.sql, adapter.format('SELECT 1'));
      assert.strictEqual(result.attempts, 2);
      assert.strictEqual(result.errors?.length, 1);
      assert.strictEqual(calls.length, 2);
    });

    it('retries on NoOutputGeneratedError and succeeds on next attempt', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([
        new NoOutputGeneratedError(),
        { result: { sql: 'SELECT 1', reasoning: 'test' } },
      ]);

      const result = await toSql({
        input: 'query',
        adapter,
        fragments: [],
        model,
      });

      assert.strictEqual(result.sql, adapter.format('SELECT 1'));
      assert.strictEqual(result.attempts, 2);
      assert.strictEqual(result.errors?.length, 1);
      assert.strictEqual(calls.length, 2);
    });

    it('retries on NoContentGeneratedError and succeeds on next attempt', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([
        new NoContentGeneratedError(),
        { result: { sql: 'SELECT 1', reasoning: 'test' } },
      ]);

      const result = await toSql({
        input: 'query',
        adapter,
        fragments: [],
        model,
      });

      assert.strictEqual(result.sql, adapter.format('SELECT 1'));
      assert.strictEqual(result.attempts, 2);
      assert.strictEqual(result.errors?.length, 1);
      assert.strictEqual(calls.length, 2);
    });
  });

  describe('non-retryable errors', () => {
    it('does not retry on unknown error types and makes only one attempt', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([
        new Error('Unknown internal failure'),
        { result: { sql: 'SELECT 1', reasoning: 'test' } },
      ]);

      await assert.rejects(
        () =>
          toSql({
            input: 'query',
            adapter,
            fragments: [],
            model,
            maxRetries: 3,
          }),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.strictEqual(error.message, 'Unknown internal failure');
          return true;
        },
      );

      assert.strictEqual(calls.length, 1);
    });

    it('does not retry UnanswerableSQLError and makes only one attempt', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([
        { result: { error: 'No table matches this question' } },
        { result: { sql: 'SELECT 1', reasoning: 'test' } },
      ]);

      await assert.rejects(
        () =>
          toSql({
            input: 'query',
            adapter,
            fragments: [],
            model,
            maxRetries: 3,
          }),
        (error: unknown) => {
          assert(UnanswerableSQLError.isInstance(error));
          return true;
        },
      );

      assert.strictEqual(calls.length, 1);
    });
  });

  describe('prompt assembly', () => {
    it('includes schema fragments in model prompt', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([
        { result: { sql: 'SELECT 1', reasoning: 'test' } },
      ]);

      await toSql({
        input: 'query',
        adapter,
        fragments: [
          fragment('db_schema', 'CREATE TABLE orders (id INT, total DECIMAL)'),
        ],
        model,
      });

      const promptContent = JSON.stringify(calls[0].messages);
      assert.ok(
        promptContent.includes('CREATE TABLE orders'),
        'Prompt should contain schema fragment content',
      );
    });

    it('includes instruction fragments in model prompt', async () => {
      const { adapter } = await init_db('', { validate: () => undefined });
      const { model, calls } = createCapturingModel([
        { result: { sql: 'SELECT 1', reasoning: 'test' } },
      ]);

      await toSql({
        input: 'query',
        adapter,
        fragments: [fragment('rule', 'Always use LIMIT 10')],
        model,
      });

      const promptContent = JSON.stringify(calls[0].messages);
      assert.ok(
        promptContent.includes('Always use LIMIT 10'),
        'Prompt should contain instruction fragment content',
      );
    });
  });

  describe('format', () => {
    it('pretty-prints SQL with line breaks and indentation', async () => {
      const { adapter } = await init_db('');
      const formatted = adapter.format(
        'SELECT id, name FROM users WHERE active = 1',
      );
      assert.ok(
        formatted.includes('\n'),
        'formatted SQL should contain line breaks',
      );
      assert.ok(
        formatted.includes('SELECT'),
        'formatted SQL should contain SELECT keyword',
      );
      assert.ok(
        formatted.includes('users'),
        'formatted SQL should preserve table name',
      );
    });

    it('returns original on unparseable input', async () => {
      const { adapter } = await init_db('');
      const garbage = '{{not sql at all}}';
      assert.strictEqual(adapter.format(garbage), garbage);
    });

    it('handles empty string', async () => {
      const { adapter } = await init_db('');
      assert.strictEqual(adapter.format(''), '');
    });
  });
});
