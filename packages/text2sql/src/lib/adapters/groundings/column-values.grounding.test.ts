import assert from 'node:assert';
import { describe, it } from 'node:test';

import type { TableConstraint } from '../adapter.ts';
import {
  ColumnValuesGrounding,
  type Column,
  type ColumnValuesGroundingConfig,
} from './column-values.grounding.ts';

/**
 * Test implementation that exposes protected methods for testing.
 */
class TestColumnValuesGrounding extends ColumnValuesGrounding {
  constructor(config: ColumnValuesGroundingConfig = {}) {
    super(config);
  }

  // Expose protected method for testing
  public testParseCheckConstraint(
    constraint: TableConstraint,
    columnName: string,
  ): string[] | undefined {
    return this.parseCheckConstraint(constraint, columnName);
  }

  // Implement abstract method (not used in these tests)
  protected async collectLowCardinality(
    _tableName: string,
    _column: Column,
  ): Promise<string[] | undefined> {
    return undefined;
  }
}

describe('ColumnValuesGrounding', () => {
  describe('parseCheckConstraint', () => {
    const grounding = new TestColumnValuesGrounding();

    describe('IN clause patterns', () => {
      it('should parse simple IN clause', () => {
        const constraint: TableConstraint = {
          name: 'check_status',
          type: 'CHECK',
          definition: "status IN ('active', 'inactive', 'pending')",
          columns: ['status'],
        };

        const values = grounding.testParseCheckConstraint(constraint, 'status');

        assert.deepStrictEqual(values, ['active', 'inactive', 'pending']);
      });

      it('should parse IN clause with extra whitespace', () => {
        const constraint: TableConstraint = {
          name: 'check_status',
          type: 'CHECK',
          definition: "status  IN  ( 'active' , 'inactive' )",
          columns: ['status'],
        };

        const values = grounding.testParseCheckConstraint(constraint, 'status');

        assert.deepStrictEqual(values, ['active', 'inactive']);
      });

      it('should parse IN clause with parenthesized column', () => {
        const constraint: TableConstraint = {
          name: 'check_status',
          type: 'CHECK',
          definition: "(status) IN ('active', 'inactive')",
          columns: ['status'],
        };

        const values = grounding.testParseCheckConstraint(constraint, 'status');

        assert.deepStrictEqual(values, ['active', 'inactive']);
      });

      it('should parse IN clause with type cast', () => {
        const constraint: TableConstraint = {
          name: 'check_status',
          type: 'CHECK',
          definition: "((status)::text IN ('active'::text, 'inactive'::text))",
          columns: ['status'],
        };

        const values = grounding.testParseCheckConstraint(constraint, 'status');

        assert.deepStrictEqual(values, ['active', 'inactive']);
      });
    });

    describe('ANY/ARRAY patterns (PostgreSQL)', () => {
      it('should parse ANY(ARRAY[...]) pattern', () => {
        const constraint: TableConstraint = {
          name: 'check_status',
          type: 'CHECK',
          definition:
            "((status)::text = ANY (ARRAY['active'::text, 'inactive'::text]))",
          columns: ['status'],
        };

        const values = grounding.testParseCheckConstraint(constraint, 'status');

        assert.deepStrictEqual(values, ['active', 'inactive']);
      });

      it('should parse ANY(ARRAY[...]) without type casts', () => {
        const constraint: TableConstraint = {
          name: 'check_status',
          type: 'CHECK',
          definition: "status = ANY(ARRAY['active', 'inactive', 'pending'])",
          columns: ['status'],
        };

        const values = grounding.testParseCheckConstraint(constraint, 'status');

        assert.deepStrictEqual(values, ['active', 'inactive', 'pending']);
      });
    });

    describe('OR patterns', () => {
      it('should parse multiple OR equality conditions', () => {
        const constraint: TableConstraint = {
          name: 'check_status',
          type: 'CHECK',
          definition:
            "status = 'active' OR status = 'inactive' OR status = 'pending'",
          columns: ['status'],
        };

        const values = grounding.testParseCheckConstraint(constraint, 'status');

        assert.deepStrictEqual(values, ['active', 'inactive', 'pending']);
      });

      it('should not match single OR condition (not enough values)', () => {
        const constraint: TableConstraint = {
          name: 'check_status',
          type: 'CHECK',
          definition: "status = 'active'",
          columns: ['status'],
        };

        const values = grounding.testParseCheckConstraint(constraint, 'status');

        assert.strictEqual(values, undefined);
      });
    });

    describe('edge cases', () => {
      it('should return undefined for non-CHECK constraint', () => {
        const constraint: TableConstraint = {
          name: 'pk_status',
          type: 'PRIMARY_KEY',
          columns: ['status'],
        };

        const values = grounding.testParseCheckConstraint(constraint, 'status');

        assert.strictEqual(values, undefined);
      });

      it('should return undefined for CHECK without definition', () => {
        const constraint: TableConstraint = {
          name: 'check_status',
          type: 'CHECK',
          columns: ['status'],
        };

        const values = grounding.testParseCheckConstraint(constraint, 'status');

        assert.strictEqual(values, undefined);
      });

      it('should return undefined when column does not match', () => {
        const constraint: TableConstraint = {
          name: 'check_status',
          type: 'CHECK',
          definition: "status IN ('active', 'inactive')",
          columns: ['status'],
        };

        const values = grounding.testParseCheckConstraint(
          constraint,
          'other_column',
        );

        assert.strictEqual(values, undefined);
      });

      it('should return undefined for numeric range check', () => {
        const constraint: TableConstraint = {
          name: 'check_age',
          type: 'CHECK',
          definition: 'age >= 0 AND age <= 150',
          columns: ['age'],
        };

        const values = grounding.testParseCheckConstraint(constraint, 'age');

        assert.strictEqual(values, undefined);
      });

      it('should handle column names with special regex characters', () => {
        const constraint: TableConstraint = {
          name: 'check_status',
          type: 'CHECK',
          definition: "user_status IN ('active', 'inactive')",
          columns: ['user_status'],
        };

        const values = grounding.testParseCheckConstraint(
          constraint,
          'user_status',
        );

        assert.deepStrictEqual(values, ['active', 'inactive']);
      });

      it('should handle empty values list', () => {
        const constraint: TableConstraint = {
          name: 'check_status',
          type: 'CHECK',
          definition: 'status IN ()',
          columns: ['status'],
        };

        const values = grounding.testParseCheckConstraint(constraint, 'status');

        assert.strictEqual(values, undefined);
      });
    });
  });
});
