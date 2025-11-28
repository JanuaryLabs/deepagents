import type { GeneratedTeachable, Teachables } from '../teach/teachables.ts';

export interface StoredTeachable {
  id: string;
  userId: string;
  type: GeneratedTeachable['type'];
  data: GeneratedTeachable;
  createdAt: string;
  updatedAt: string;
}

export abstract class TeachablesStore {
  /**
   * Remember a teachable for a user.
   */
  abstract remember(
    userId: string,
    data: GeneratedTeachable,
  ): Promise<StoredTeachable>;

  /**
   * Recall teachables for a user, optionally filtered by type.
   */
  abstract recall(
    userId: string,
    type?: GeneratedTeachable['type'],
  ): Promise<StoredTeachable[]>;

  /**
   * Get a specific teachable by ID.
   */
  abstract get(id: string): Promise<StoredTeachable | null>;

  /**
   * Update an existing teachable.
   */
  abstract update(
    id: string,
    data: GeneratedTeachable,
  ): Promise<StoredTeachable>;

  /**
   * Forget (remove) a specific teachable by ID.
   */
  abstract forget(id: string): Promise<void>;

  /**
   * Forget all teachables for a user.
   */
  abstract forgetAll(userId: string): Promise<void>;

  /**
   * Convert stored teachables to Teachables array for use with toInstructions().
   */
  abstract toTeachables(userId: string): Promise<Teachables[]>;
}
