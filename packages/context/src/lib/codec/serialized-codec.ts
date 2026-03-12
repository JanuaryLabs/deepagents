import {
  type FragmentData,
  isFragment,
  isFragmentObject,
  isMessageFragment,
} from '../fragments.ts';

export function encodeSerializedValue(value: FragmentData): unknown {
  if (isFragment(value)) {
    if (isMessageFragment(value)) {
      throw new Error(
        'Message fragments are not supported by serialized fragment conversion',
      );
    }

    if (!value.codec) {
      throw new Error(`Fragment "${value.name}" is missing codec`);
    }

    return value.codec.encode();
  }

  if (Array.isArray(value)) {
    return value.map((item) => encodeSerializedValue(item));
  }

  if (isFragmentObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        encodeSerializedValue(entry),
      ]),
    );
  }

  return value;
}
