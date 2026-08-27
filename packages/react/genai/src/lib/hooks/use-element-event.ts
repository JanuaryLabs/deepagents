import { useEffect } from 'react';

export function useEventListener(
  eventName: string,
  handler: EventListener,
  selector: string,
) {
  useEffect(() => {
    const element = document.querySelector(selector);
    if (!element) return;
    element.addEventListener(eventName, handler);
    return () => {
      element.removeEventListener(eventName, handler);
    };
  }, [eventName, handler, selector]);
}
