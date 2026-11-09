export const userTurn = (id: string, text: string) => ({
  message: {
    id,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
  },
  trigger: 'submit-message' as const,
});
