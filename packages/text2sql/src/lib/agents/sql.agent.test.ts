import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { Adapter } from '@deepagents/text2sql';
import {
  toSql,
  sqlGenerators,
  type GenerateSqlParams,
  type GenerateSqlResult,
} from './sql.agent.ts';

describe('toSql', () => {
  // Mock state - reset in beforeEach for test isolation
  let mockGenerateCalls: GenerateSqlParams[];
  let mockGenerateResponses: GenerateSqlResult[];
  let mockValidateCalls: string[];
  let mockValidateResponses: (string | undefined)[];

  beforeEach(() => {
    mockGenerateCalls = [];
    mockGenerateResponses = [];
    mockValidateCalls = [];
    mockValidateResponses = [];

    // Mock generateSql using mock.method on the exported object
    mock.method(sqlGenerators, 'generateSql', async (params: GenerateSqlParams) => {
      mockGenerateCalls.push(params);
      return mockGenerateResponses.shift() ?? { success: false, error: 'No mock response' };
    });
  });

  function createMockAdapter(): Adapter {
    return {
      validate: (sql: string) => {
        mockValidateCalls.push(sql);
        return mockValidateResponses.shift();
      },
    } as unknown as Adapter;
  }

  describe('successful generation', () => {
    it('should return SQL when generation succeeds on first attempt', async () => {
      mockGenerateResponses = [{ success: true, sql: 'SELECT * FROM users' }];
      mockValidateResponses = [undefined]; // validation passes

      const result = await toSql({
        input: 'get all users',
        adapter: createMockAdapter(),
        introspection: '<schema>users table</schema>',
        instructions: [],
      });

      assert.strictEqual(result.sql, 'SELECT * FROM users');
      assert.strictEqual(result.attempts, 1);
      assert.strictEqual(result.errors, undefined);
    });
  });

  describe('retry on SQL validation error', () => {
    it('should retry when SQL validation fails then succeed', async () => {
      mockGenerateResponses = [
        { success: true, sql: 'SELECT * FORM users' },
        { success: true, sql: 'SELECT * FROM users' },
      ];
      mockValidateResponses = ['syntax error near FORM', undefined];

      const result = await toSql({
        input: 'get all users',
        adapter: createMockAdapter(),
        introspection: '',
        instructions: [],
      });

      assert.strictEqual(result.sql, 'SELECT * FROM users');
      assert.strictEqual(result.attempts, 2);
      assert.deepStrictEqual(result.errors, ['syntax error near FORM']);
    });
  });

  describe('retry on JSON validation error', () => {
    it('should retry when API returns JSON validation error', async () => {
      mockGenerateResponses = [
        { success: false, error: 'JSON validation failed: invalid response' },
        { success: true, sql: 'SELECT * FROM users' },
      ];
      mockValidateResponses = [undefined];

      const result = await toSql({
        input: 'get all users',
        adapter: createMockAdapter(),
        introspection: '',
        instructions: [],
      });

      assert.strictEqual(result.sql, 'SELECT * FROM users');
      assert.strictEqual(result.attempts, 2);
      assert.deepStrictEqual(result.errors, ['JSON validation failed: invalid response']);
    });
  });

  describe('exhausted retries', () => {
    it('should return empty SQL when all retries fail', async () => {
      mockGenerateResponses = [
        { success: true, sql: 'bad1' },
        { success: true, sql: 'bad2' },
        { success: true, sql: 'bad3' },
      ];
      mockValidateResponses = ['error1', 'error2', 'error3'];

      const result = await toSql({
        input: 'query',
        adapter: createMockAdapter(),
        introspection: '',
        instructions: [],
      });

      assert.strictEqual(result.sql, '');
      assert.strictEqual(result.attempts, 3);
      assert.strictEqual(result.errors?.length, 3);
    });

    it('should respect custom maxRetries', async () => {
      mockGenerateResponses = Array(5).fill({ success: true, sql: 'bad' });
      mockValidateResponses = Array(5).fill('error');

      const result = await toSql({
        input: 'query',
        adapter: createMockAdapter(),
        introspection: '',
        instructions: [],
        maxRetries: 5,
      });

      assert.strictEqual(result.attempts, 5);
      assert.strictEqual(result.errors?.length, 5);
    });
  });

  describe('error propagation', () => {
    it('should pass previous error to generateSql on retry', async () => {
      mockGenerateResponses = [
        { success: true, sql: 'bad' },
        { success: true, sql: 'SELECT 1' },
      ];
      mockValidateResponses = ['first error', undefined];

      await toSql({
        input: 'query',
        adapter: createMockAdapter(),
        introspection: '',
        instructions: [],
      });

      assert.strictEqual(mockGenerateCalls[0].previousError, undefined);
      assert.strictEqual(mockGenerateCalls[1].previousError, 'first error');
    });
  });

  describe('temperature progression', () => {
    it('should increase temperature on retries', async () => {
      mockGenerateResponses = [
        { success: true, sql: 'bad1' },
        { success: true, sql: 'bad2' },
        { success: true, sql: 'bad3' },
      ];
      mockValidateResponses = ['e1', 'e2', 'e3'];

      await toSql({
        input: 'query',
        adapter: createMockAdapter(),
        introspection: '',
        instructions: [],
      });

      assert.strictEqual(mockGenerateCalls[0].temperature, 0);
      assert.strictEqual(mockGenerateCalls[1].temperature, 0.2);
      assert.strictEqual(mockGenerateCalls[2].temperature, 0.3);
    });
  });

  describe('mixed error types', () => {
    it('should handle JSON error then SQL error then success', async () => {
      mockGenerateResponses = [
        { success: false, error: 'JSON error' },
        { success: true, sql: 'bad sql' },
        { success: true, sql: 'SELECT 1' },
      ];
      // Note: validate is only called when generation succeeds
      // Attempt 1: JSON error (validate NOT called)
      // Attempt 2: SQL error (validate called, returns 'SQL error')
      // Attempt 3: success (validate called, returns undefined)
      mockValidateResponses = ['SQL error', undefined];

      const result = await toSql({
        input: 'query',
        adapter: createMockAdapter(),
        introspection: '',
        instructions: [],
      });

      assert.strictEqual(result.attempts, 3);
      assert.deepStrictEqual(result.errors, ['JSON error', 'SQL error']);
    });
  });
});
