import { type ContextFragment, fragment } from '../fragments.ts';
import protocol from './protocol.md';

export function soul(): ContextFragment {
  const children: ContextFragment[] = [{ name: 'protocol', data: protocol }];
  return fragment('soul_protocol', ...children);
}
