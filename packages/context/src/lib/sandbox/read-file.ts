import type {
  ReadFileContent,
  ReadFileEncoding,
  ReadFileOptions,
} from './types.ts';

const decoder = new TextDecoder();

/**
 * Shape the bytes a backend read into what `Sandbox.readFile` promised for
 * `options.encoding`. Every backend reads bytes and ends here, so this is the
 * one place the conditional return type is asserted.
 */
export function readFileContent<Encoding extends ReadFileEncoding>(
  bytes: Uint8Array,
  options: ReadFileOptions<Encoding> | undefined,
): ReadFileContent<Encoding> {
  const content =
    options?.encoding === 'binary' ? bytes : decoder.decode(bytes);
  return content as ReadFileContent<Encoding>;
}
