import { z } from 'zod';

export const optionSchema = z.object({
  label: z.string().describe('Display text for the option'),
  value: z.string().optional().describe('Machine value; defaults to label'),
  description: z.string().optional().describe('Helper text for the option'),
});

export const questionSchema = z.object({
  type: z.literal('choice').describe('Selection from predefined options'),
  question: z.string().describe('The question text displayed to the user'),
  header: z.string().optional().describe('Short context label'),
  multiSelect: z
    .boolean()
    .default(false)
    .describe('Whether multiple options can be selected'),
  options: z.array(optionSchema).min(1).describe('Available choices'),
});

export const inputSchema = z.preprocess(
  (value: unknown) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'questions' in value &&
      Array.isArray(value.questions)
    ) {
      return {
        ...value,
        questions: value.questions.map((question) =>
          typeof question === 'object' && question !== null
            ? { ...question, type: 'choice' }
            : question,
        ),
      };
    }
    return value;
  },
  z.object({
    questions: z
      .array(questionSchema)
      .min(1)
      .describe('Questions to present as a wizard'),
  }),
);

export type Question = z.infer<typeof questionSchema>;
export type ChoiceOption = {
  label: string;
  value: string;
  description?: string;
};
export type ChoiceAnswer = {
  type: 'choice';
  multiSelect: boolean;
  selected: string | null;
  selectedMulti: string[];
  isOther: boolean;
  customText: string;
  notes: string;
};

const choiceValuePairSchema = z.object({
  label: z.string(),
  value: z.string(),
});

export const baseOutputAnswerSchema = z.object({
  type: z.string(),
  question: z.string(),
  freeText: z.string().optional(),
  notes: z.string().optional(),
  choice: choiceValuePairSchema.optional(),
  choices: z.array(choiceValuePairSchema).optional(),
  multiSelect: z.boolean().optional(),
  answer: z.string().optional(),
});

export const outputSchema = z.object({
  answers: z.array(baseOutputAnswerSchema),
});

export type BaseOutputAnswer = z.infer<typeof baseOutputAnswerSchema>;

export function validateAnswer(answer: ChoiceAnswer): string | null {
  if (answer.multiSelect) {
    if (answer.selectedMulti.length === 0 && !answer.customText.trim()) {
      return 'Pick at least one option or add your own answer.';
    }
  } else {
    if (!answer.selected && !answer.isOther) {
      return 'Select an option or add your own answer.';
    }
    if (answer.isOther && !answer.customText.trim()) {
      return 'Add your custom answer for the "Other" option.';
    }
  }

  return null;
}

export function createInitialAnswer(question: Question): ChoiceAnswer {
  return {
    type: 'choice',
    multiSelect: question.multiSelect ?? false,
    selected: null,
    selectedMulti: [],
    isOther: false,
    customText: '',
    notes: '',
  };
}

export function prepareOptions(question: Question): ChoiceOption[] {
  return question.options
    .filter(
      (option) =>
        (option.value ?? option.label).toLowerCase() !== 'other' &&
        option.label.toLowerCase() !== 'other',
    )
    .map((option) => ({
      label: option.label,
      value: option.value ?? option.label,
      description: option.description,
    }));
}

export function buildBaseOutputAnswer(
  question: Question,
  answer: ChoiceAnswer,
  options: ChoiceOption[],
): BaseOutputAnswer {
  const normalizedChoice = (value: string) => {
    const match = options.find((option) => option.value === value);
    return match
      ? { label: match.label, value: match.value }
      : { label: value, value };
  };
  const notes = answer.notes.trim() || undefined;
  const freeText = answer.customText.trim() || undefined;

  if (answer.multiSelect) {
    const choices = answer.selectedMulti.map(normalizedChoice);
    if (freeText) choices.push({ label: 'Other', value: freeText });
    return {
      type: 'choice',
      question: question.question,
      multiSelect: true,
      choices,
      freeText,
      notes,
    };
  }

  return {
    type: 'choice',
    question: question.question,
    multiSelect: false,
    choice: answer.isOther
      ? { label: 'Other', value: freeText ?? '' }
      : normalizedChoice(answer.selected ?? ''),
    freeText: answer.isOther ? freeText : undefined,
    notes,
  };
}
