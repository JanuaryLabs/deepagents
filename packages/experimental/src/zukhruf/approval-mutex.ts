/** Serializes approval state transitions for one durable conversation. */
export abstract class ApprovalMutex {
  abstract runExclusive<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}
