import { Loader2, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip.tsx';

interface TheButtonProps extends React.ComponentProps<typeof Button> {
  /**
   * Shows a loading spinner after the delay period.
   * Disables the button while loading.
   */
  loading?: boolean;
  /**
   * Icon to display before the button text.
   * Can be a React node or a Lucide icon component.
   */
  icon?: React.ReactNode | LucideIcon;
  /**
   * Delay in milliseconds before showing the loading spinner.
   * @default 300
   */
  delay?: number;
  /**
   * Tooltip text shown on hover. When provided with `size="icon"`,
   * creates an icon-only button with tooltip.
   */
  tooltip?: string;
}

// --- Internal Components ---

function useDelayedLoading(loading: boolean | undefined, delay: number) {
  loading = !!loading;
  const [delayPassed, setDelayPassed] = useState(false);

  useEffect(() => {
    if (!loading) {
      return;
    }

    const timerId = setTimeout(() => {
      setDelayPassed(true);
    }, delay);

    return () => {
      clearTimeout(timerId);
      queueMicrotask(() => setDelayPassed(false));
    };
  }, [loading, delay]);

  return loading && delayPassed;
}

function isComponent(
  value: unknown,
): value is React.ComponentType<{ className?: string }> {
  if (typeof value === 'function') return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    '$$typeof' in value &&
    typeof (value as Record<string, unknown>).render === 'function'
  );
}

function IconRenderer({ icon }: { icon: React.ReactNode | LucideIcon }) {
  if (isComponent(icon)) {
    const Icon = icon;
    return <Icon className="size-4" />;
  }
  return <>{icon}</>;
}

function LoadingSpinner() {
  return <Loader2 className="size-4 animate-spin" />;
}

function IconButtonContent({
  icon,
  showSpinner,
}: {
  icon?: React.ReactNode | LucideIcon;
  showSpinner: boolean;
}) {
  return (
    <div className="relative size-4 overflow-hidden">
      {icon && (
        <div
          className={cn(
            'absolute inset-0 flex items-center justify-center transition-all duration-300 ease-in-out',
            showSpinner
              ? '-translate-x-full opacity-0'
              : 'translate-x-0 opacity-100',
          )}
        >
          <IconRenderer icon={icon} />
        </div>
      )}
      <div
        className={cn(
          'absolute inset-0 transition-all duration-300 ease-in-out',
          showSpinner
            ? 'translate-x-0 opacity-100'
            : 'translate-x-full opacity-0',
        )}
      >
        <LoadingSpinner />
      </div>
    </div>
  );
}

function TextButtonContent({
  icon,
  showSpinner,
  children,
}: {
  icon?: React.ReactNode | LucideIcon;
  showSpinner: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      {icon && (
        <div
          className={cn(
            'overflow-hidden transition-all duration-300 ease-in-out',
            showSpinner ? 'w-0 opacity-0' : 'w-4 opacity-100',
          )}
        >
          <IconRenderer icon={icon} />
        </div>
      )}
      <div
        className={cn(
          'overflow-hidden transition-all duration-300 ease-in-out',
          showSpinner ? '-ms-2 w-4 opacity-100' : '-ms-2 w-0 opacity-0',
        )}
      >
        <LoadingSpinner />
      </div>
      {children}
    </>
  );
}

function WithTooltip({
  tooltip,
  children,
}: {
  tooltip?: string;
  children: React.ReactNode;
}) {
  if (!tooltip) {
    return <>{children}</>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A versatile button component with loading state and tooltip support.
 *
 * Supports all standard Button variants and sizes from shadcn/ui,
 * plus additional features for loading states and icon-only buttons.
 *
 * @example
 * // Basic button
 * <TheButton>Click me</TheButton>
 *
 * @example
 * // Primary button with loading state
 * <TheButton loading={isSubmitting}>
 *   Submit
 * </TheButton>
 *
 * @example
 * // Button with icon
 * <TheButton icon={<Save className="size-4" />}>
 *   Save Changes
 * </TheButton>
 *
 * @example
 * // Using Lucide icon directly
 * <TheButton icon={Trash}>
 *   Delete
 * </TheButton>
 *
 * @example
 * // Icon-only button with tooltip
 * <TheButton
 *   size="icon"
 *   variant="outline"
 *   icon={Settings}
 *   tooltip="Open settings"
 * />
 *
 * @example
 * // Destructive variant
 * <TheButton variant="destructive" icon={Trash}>
 *   Delete Item
 * </TheButton>
 *
 * @example
 * // Ghost variant (for toolbars, menus)
 * <TheButton variant="ghost" size="sm">
 *   Cancel
 * </TheButton>
 *
 * @example
 * // Secondary variant
 * <TheButton variant="secondary">
 *   Secondary Action
 * </TheButton>
 *
 * @example
 * // Link variant
 * <TheButton variant="link">
 *   Learn more
 * </TheButton>
 *
 * @example
 * // Outline variant with custom delay
 * <TheButton variant="outline" loading={isPending} delay={500}>
 *   Processing...
 * </TheButton>
 *
 * @example
 * // Small size
 * <TheButton size="sm" icon={Plus}>
 *   Add Item
 * </TheButton>
 *
 * @example
 * // Large size
 * <TheButton size="lg">
 *   Get Started
 * </TheButton>
 */
export function TheButton({
  loading,
  disabled,
  children,
  delay = 300,
  icon,
  tooltip,
  size,
  ...props
}: TheButtonProps) {
  const showSpinner = useDelayedLoading(loading, delay);
  const isIconButton = size?.startsWith('icon');

  return (
    <WithTooltip tooltip={tooltip}>
      <Button
        disabled={disabled || loading}
        size={size}
        {...props}
        className={cn('cursor-pointer gap-2', props.className)}
      >
        {isIconButton ? (
          <IconButtonContent icon={icon} showSpinner={showSpinner} />
        ) : (
          <TextButtonContent icon={icon} showSpinner={showSpinner}>
            {children}
          </TextButtonContent>
        )}
      </Button>
    </WithTooltip>
  );
}
