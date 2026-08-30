import { Check, ChevronRight } from 'lucide-react';
import { useRef } from 'react';

import {
  Button,
  Checkbox,
  Label,
  RadioGroup,
  RadioGroupItem,
  Separator,
  Spinner,
  Textarea,
  cn,
} from '@deepagents/react-shadcn';

import type {
  BaseOutputAnswer,
  ChoiceAnswer,
  ChoiceOption,
  Question,
} from './schemas.ts';
import { prepareOptions } from './schemas.ts';

export function OptionCard({
  checked,
  children,
  disabled,
}: {
  checked: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'border-border/60 relative flex items-start gap-2 rounded-lg border px-3 py-1.5 transition-all duration-150',
        !disabled && 'hover:bg-muted/40',
        checked && 'border-primary/50 bg-primary/5',
        disabled && 'opacity-60',
      )}
    >
      {children}
    </div>
  );
}

function OptionLabel({
  htmlFor,
  label,
  description,
}: {
  htmlFor: string;
  label: string;
  description?: string;
}) {
  return (
    <Label
      htmlFor={htmlFor}
      className="min-w-0 flex-1 cursor-pointer flex-col items-start gap-0"
    >
      <span className="text-sm font-medium">{label}</span>
      {description ? (
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          {description}
        </p>
      ) : null}
    </Label>
  );
}

function RadioOption({
  id,
  value,
  label,
  description,
  checked,
  disabled,
}: {
  id: string;
  value: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled: boolean;
}) {
  return (
    <OptionCard checked={checked} disabled={disabled}>
      <RadioGroupItem
        id={id}
        value={value}
        disabled={disabled}
        className="mt-0.5"
      />
      <OptionLabel htmlFor={id} label={label} description={description} />
    </OptionCard>
  );
}

function CheckboxOption({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <OptionCard checked={checked} disabled={disabled}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        className="mt-0.5"
      />
      <OptionLabel htmlFor={id} label={label} description={description} />
    </OptionCard>
  );
}

function OtherRadioOption({
  id,
  checked,
  disabled,
  customText,
  onCustomTextChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  customText: string;
  onCustomTextChange: (value: string) => void;
}) {
  const radioRef = useRef<HTMLButtonElement>(null);

  return (
    <OptionCard checked={checked} disabled={disabled}>
      <RadioGroupItem
        ref={radioRef}
        id={id}
        value="other"
        disabled={disabled}
        className="mt-0.5"
      />
      <input
        value={customText}
        onChange={(event) => onCustomTextChange(event.target.value)}
        placeholder="Type your answer..."
        disabled={disabled}
        onFocus={() => {
          if (!checked) radioRef.current?.click();
        }}
        className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none disabled:cursor-not-allowed"
      />
    </OptionCard>
  );
}

function OtherCheckboxOption({
  hasCustom,
  disabled,
  customText,
  onCustomTextChange,
  onClear,
}: {
  hasCustom: boolean;
  disabled: boolean;
  customText: string;
  onCustomTextChange: (value: string) => void;
  onClear: () => void;
}) {
  const checkboxRef = useRef<HTMLButtonElement>(null);

  return (
    <OptionCard checked={hasCustom} disabled={disabled}>
      <Checkbox
        ref={checkboxRef}
        checked={hasCustom}
        disabled={disabled}
        onCheckedChange={(checked) => {
          if (!checked) onClear();
        }}
        className="mt-0.5"
      />
      <input
        value={customText}
        onChange={(event) => onCustomTextChange(event.target.value)}
        placeholder="Type your answer..."
        disabled={disabled}
        onFocus={() => {
          if (!hasCustom) checkboxRef.current?.click();
        }}
        className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none disabled:cursor-not-allowed"
      />
    </OptionCard>
  );
}

export function NotesField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-2.5 border-t border-dashed pt-2.5">
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Add notes (optional)..."
        disabled={disabled}
        rows={2}
        className="resize-none text-sm"
      />
    </div>
  );
}

export function ChoiceField({
  value,
  onChange,
  options,
  disabled,
  fieldId,
}: {
  value: ChoiceAnswer;
  onChange: (value: ChoiceAnswer) => void;
  options: ChoiceOption[];
  disabled: boolean;
  fieldId: string;
}) {
  if (value.multiSelect) {
    const hasCustom = value.customText.trim().length > 0;
    const handleCheckChange = (optionValue: string, checked: boolean) => {
      const selected = new Set(value.selectedMulti);
      if (checked) selected.add(optionValue);
      else selected.delete(optionValue);
      onChange({ ...value, selectedMulti: [...selected] });
    };

    return (
      <div className="space-y-1.5">
        {options.map((option) => (
          <CheckboxOption
            key={option.value}
            id={`${fieldId}-multi-${option.value}`}
            label={option.label}
            description={option.description}
            checked={value.selectedMulti.includes(option.value)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              handleCheckChange(option.value, checked)
            }
          />
        ))}
        <OtherCheckboxOption
          hasCustom={hasCustom}
          disabled={disabled}
          customText={value.customText}
          onCustomTextChange={(customText) =>
            onChange({ ...value, customText })
          }
          onClear={() => onChange({ ...value, customText: '' })}
        />
      </div>
    );
  }

  return (
    <RadioGroup
      value={value.isOther ? 'other' : (value.selected ?? '')}
      onValueChange={(selected) =>
        onChange(
          selected === 'other'
            ? { ...value, selected: null, isOther: true }
            : { ...value, selected, isOther: false, customText: '' },
        )
      }
    >
      {options.map((option) => (
        <RadioOption
          key={option.value}
          id={`${fieldId}-single-${option.value}`}
          value={option.value}
          label={option.label}
          description={option.description}
          checked={!value.isOther && value.selected === option.value}
          disabled={disabled}
        />
      ))}
      <OtherRadioOption
        id={`${fieldId}-single-other`}
        checked={value.isOther}
        disabled={disabled}
        customText={value.customText}
        onCustomTextChange={(customText) =>
          onChange({ ...value, customText })
        }
      />
    </RadioGroup>
  );
}

export function StepProgress({
  current,
  total,
}: {
  current: number;
  total: number;
}) {
  if (total <= 1) return null;

  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: total }, (_, index) => (
        <div
          key={index}
          className={cn(
            'h-1 w-3 rounded-full transition-colors duration-200',
            index <= current ? 'bg-primary' : 'bg-muted',
          )}
        />
      ))}
    </div>
  );
}

export function StepNavigation({
  onBack,
  onNext,
  isFirst,
  isLast,
  canProceed,
  isSubmitting,
  isSubmitted,
  currentStep,
  totalSteps,
}: {
  onBack: () => void;
  onNext: () => void;
  isFirst: boolean;
  isLast: boolean;
  canProceed: boolean;
  isSubmitting: boolean;
  isSubmitted: boolean;
  currentStep: number;
  totalSteps: number;
}) {
  if (isSubmitted) return null;

  return (
    <div className="flex items-center justify-between border-t border-dashed px-3 py-1.5">
      <div className="w-16">
        {!isFirst ? (
          <button
            type="button"
            onClick={onBack}
            disabled={isSubmitting}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors disabled:opacity-50"
          >
            &larr; Back
          </button>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <StepProgress current={currentStep} total={totalSteps} />
        {totalSteps > 1 ? (
          <span className="text-muted-foreground text-[11px] tabular-nums">
            {currentStep + 1}/{totalSteps}
          </span>
        ) : null}
      </div>

      <div className="flex w-16 justify-end">
        <Button
          type="button"
          size="sm"
          onClick={onNext}
          disabled={!canProceed || isSubmitting}
        >
          {isSubmitting ? <Spinner /> : null}
          {isSubmitting ? 'Sending...' : isLast ? 'Submit' : 'Next'}
        </Button>
      </div>
    </div>
  );
}

export function QuestionHeader({ question }: { question: Question }) {
  return (
    <div className="px-3 pt-2.5 pb-2">
      <div className="text-muted-foreground mb-2 flex items-center gap-2 text-[11px]">
        <ChevronRight className="size-3" />
        <span>{question.header ?? 'Clarification'}</span>
      </div>
      <Separator className="mb-2" />
      <p className="text-sm font-medium text-pretty">{question.question}</p>
    </div>
  );
}

export function QuestionField({
  question,
  answer,
  options,
  onChange,
  disabled,
  fieldId,
}: {
  question: Question;
  answer: ChoiceAnswer;
  options: ChoiceOption[];
  onChange: (answer: ChoiceAnswer) => void;
  disabled: boolean;
  fieldId: string;
}) {
  return (
    <>
      <ChoiceField
        value={answer}
        onChange={onChange}
        options={options}
        disabled={disabled}
        fieldId={fieldId}
      />
      <NotesField
        value={answer.notes}
        onChange={(notes) => onChange({ ...answer, notes })}
        disabled={disabled}
      />
    </>
  );
}

export function SubmittedAnswer({
  question,
  answer,
  options,
}: {
  question: Question;
  answer: ChoiceAnswer;
  options: ChoiceOption[];
}) {
  const displayValue = answer.multiSelect
    ? [
        ...answer.selectedMulti.map(
          (selected) =>
            options.find((option) => option.value === selected)?.label ??
            selected,
        ),
        ...(answer.customText.trim()
          ? [`Other: ${answer.customText.trim()}`]
          : []),
      ].join(', ')
    : answer.isOther
      ? `Other: ${answer.customText.trim()}`
      : (options.find((option) => option.value === answer.selected)?.label ??
        answer.selected ??
        '');
  const notes = answer.notes.trim() || undefined;

  return (
    <div className="px-3 py-2.5">
      <p className="text-muted-foreground text-sm text-pretty">
        {question.question}
      </p>
      <p className="mt-1 text-sm font-medium text-pretty">{displayValue}</p>
      {notes ? (
        <p className="text-muted-foreground mt-1 text-xs text-pretty italic">
          Note: {notes}
        </p>
      ) : null}
    </div>
  );
}

function outputDisplayValue(answer: BaseOutputAnswer): string {
  if (answer.type === 'free_form') return answer.answer ?? '';
  if (answer.multiSelect && answer.choices) {
    return answer.choices
      .map(({ label, value }) =>
        label === 'Other' ? `Other: ${value}` : label,
      )
      .join(', ');
  }
  if (answer.freeText) return `Other: ${answer.freeText}`;
  return answer.choice?.label ?? '';
}

export function SubmittedOutputView({
  answers,
}: {
  answers: BaseOutputAnswer[];
}) {
  return (
    <>
      <div className="px-3 pt-2.5 pb-2">
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <Check className="size-3" />
          <span>Answered</span>
        </div>
      </div>
      <Separator />
      {answers.map((answer, index) => (
        <div key={index} className="px-3 py-2.5">
          <p className="text-muted-foreground text-sm text-pretty">
            {answer.question}
          </p>
          <p className="mt-1 text-sm font-medium text-pretty">
            {outputDisplayValue(answer)}
          </p>
          {answer.notes ? (
            <p className="text-muted-foreground mt-1 text-xs text-pretty italic">
              Note: {answer.notes}
            </p>
          ) : null}
        </div>
      ))}
    </>
  );
}

export function WizardSubmitted({
  questions,
  answers,
}: {
  questions: Question[];
  answers: ChoiceAnswer[];
}) {
  return (
    <>
      <div className="px-3 pt-2.5 pb-2">
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <Check className="size-3" />
          <span>Answered</span>
        </div>
      </div>
      <Separator />
      {questions.map((question, index) => (
        <SubmittedAnswer
          key={index}
          question={question}
          answer={answers[index]}
          options={prepareOptions(question)}
        />
      ))}
    </>
  );
}
