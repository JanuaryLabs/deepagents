import type {
  ReadFileContent,
  ReadFileEncoding,
  ReadFileOptions,
} from './types.ts';

const decoder = new TextDecoder();

/**
 * Shape the bytes a backend read into what `Sandbox.readFile` promised for
 * `options.encoding`. Every backend reads bytes and ends here, so this is the
 * one place the conditional return type is bound to the runtime value: the
 * overload states the contract, the implementation returns the union.
 */
export function readFileContent<Encoding extends ReadFileEncoding>(
  bytes: Uint8Array,
  options: ReadFileOptions<Encoding> | undefined,
): ReadFileContent<Encoding>;
export function readFileContent(
  bytes: Uint8Array,
  options: ReadFileOptions<ReadFileEncoding> | undefined,
): Uint8Array | string {
  return options?.encoding === 'binary' ? bytes : decoder.decode(bytes);
}
