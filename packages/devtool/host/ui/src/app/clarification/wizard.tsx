import { createContext, use, useState } from 'react';

import {
  QuestionField,
  QuestionHeader,
  StepNavigation,
  WizardSubmitted as WizardSubmittedView,
} from './primitives.tsx';
import type {
  BaseOutputAnswer,
  ChoiceAnswer,
  ChoiceOption,
  Question,
} from './schemas.ts';
import {
  buildBaseOutputAnswer,
  createInitialAnswer,
  prepareOptions,
  validateAnswer,
} from './schemas.ts';

type WizardContextValue = {
  questions: Question[];
  currentStep: number;
  currentQuestion: Question;
  currentAnswer: ChoiceAnswer;
  options: ChoiceOption[];
  answers: ChoiceAnswer[];
  updateAnswer: (answer: ChoiceAnswer) => void;
  handleBack: () => void;
  handleNext: () => Promise<void>;
  error: string | null;
  isFirst: boolean;
  isLast: boolean;
  canProceed: boolean;
  isSubmitting: boolean;
  isSubmitted: boolean;
  disabled: boolean;
  fieldId: string;
  totalSteps: number;
};

const WizardContext = createContext<WizardContextValue | undefined>(undefined);

function useWizard() {
  const context = use(WizardContext);
  if (!context) {
    throw new Error('useWizard must be used within <ClarificationWizard.Root>');
  }
  return context;
}

function WizardRoot({
  questions,
  onSubmit,
  disabled,
  fieldId,
  children,
}: {
  questions: Question[];
  onSubmit: (answers: BaseOutputAnswer[]) => Promise<void>;
  disabled: boolean;
  fieldId: string;
  children: React.ReactNode;
}) {
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<ChoiceAnswer[]>(() =>
    questions.map(createInitialAnswer),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const currentQuestion = questions[currentStep];
  const currentAnswer = answers[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === questions.length - 1;
  const options = prepareOptions(currentQuestion);

  const updateAnswer = (answer: ChoiceAnswer) => {
    setAnswers((previous) => {
      const next = [...previous];
      next[currentStep] = answer;
      return next;
    });
    setError(null);
  };

  const handleBack = () => {
    if (isFirst) return;
    setCurrentStep((previous) => previous - 1);
    setError(null);
  };

  const handleNext = async () => {
    const validationError = validateAnswer(currentAnswer);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (!isLast) {
      setCurrentStep((previous) => previous + 1);
      setError(null);
      return;
    }

    for (let index = 0; index < questions.length; index++) {
      const stepError = validateAnswer(answers[index]);
      if (stepError) {
        setCurrentStep(index);
        setError(stepError);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      await onSubmit(
        questions.map((question, index) =>
          buildBaseOutputAnswer(
            question,
            answers[index],
            prepareOptions(question),
          ),
        ),
      );
      setIsSubmitted(true);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Failed to send your answers.',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const value: WizardContextValue = {
    questions,
    currentStep,
    currentQuestion,
    currentAnswer,
    options,
    answers,
    updateAnswer,
    handleBack,
    handleNext,
    error,
    isFirst,
    isLast,
    canProceed: !disabled && !isSubmitted,
    isSubmitting,
    isSubmitted,
    disabled,
    fieldId,
    totalSteps: questions.length,
  };

  return (
    <WizardContext.Provider value={value}>{children}</WizardContext.Provider>
  );
}

function WizardHeader() {
  const { currentQuestion, isSubmitted } = useWizard();
  return isSubmitted ? null : <QuestionHeader question={currentQuestion} />;
}

function WizardField() {
  const {
    currentQuestion,
    currentAnswer,
    options,
    updateAnswer,
    disabled,
    isSubmitting,
    isSubmitted,
    fieldId,
    currentStep,
  } = useWizard();
  if (isSubmitted) return null;

  return (
    <QuestionField
      question={currentQuestion}
      answer={currentAnswer}
      options={options}
      onChange={updateAnswer}
      disabled={disabled || isSubmitting}
      fieldId={`${fieldId}-step-${currentStep}`}
    />
  );
}

function WizardError() {
  const { error, isSubmitted } = useWizard();
  if (isSubmitted || !error) return null;
  return (
    <p className="text-destructive text-xs" role="alert">
      {error}
    </p>
  );
}

function WizardNavigation() {
  const {
    handleBack,
    handleNext,
    isFirst,
    isLast,
    canProceed,
    isSubmitting,
    isSubmitted,
    currentStep,
    totalSteps,
  } = useWizard();

  return (
    <StepNavigation
      onBack={handleBack}
      onNext={handleNext}
      isFirst={isFirst}
      isLast={isLast}
      canProceed={canProceed}
      isSubmitting={isSubmitting}
      isSubmitted={isSubmitted}
      currentStep={currentStep}
      totalSteps={totalSteps}
    />
  );
}

function WizardContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { isSubmitted } = useWizard();
  return isSubmitted ? null : <div className={className}>{children}</div>;
}

function WizardSubmitted() {
  const { questions, answers, isSubmitted } = useWizard();
  return isSubmitted ? (
    <WizardSubmittedView questions={questions} answers={answers} />
  ) : null;
}

export const ClarificationWizard = {
  Root: WizardRoot,
  Header: WizardHeader,
  Content: WizardContent,
  Field: WizardField,
  Error: WizardError,
  Navigation: WizardNavigation,
  Submitted: WizardSubmitted,
};
