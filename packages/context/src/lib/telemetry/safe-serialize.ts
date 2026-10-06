export interface TelemetryLogRecord {
  timestamp: string;
  event: string;
  data: unknown;
}

export function createTelemetryLogRecord(
  event: string,
  data: unknown,
): TelemetryLogRecord {
  return {
    timestamp: new Date().toISOString(),
    event,
    data: normalizeTelemetryValue(data),
  };
}

export function stringifyTelemetryLogRecord(
  record: TelemetryLogRecord,
  indentation?: number,
): string {
  return JSON.stringify(record, null, indentation);
}

function normalizeTelemetryValue(value: unknown): unknown {
  return normalize(value, new WeakSet());
}

function normalize(value: unknown, ancestors: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '[NaN]';
    if (value === Infinity) return '[Infinity]';
    if (value === -Infinity) return '[-Infinity]';
    if (Object.is(value, -0)) return '[-0]';
    return value;
  }
  if (typeof value === 'undefined') return '[Undefined]';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') {
    return `[Function${value.name ? ` ${value.name}` : ''}]`;
  }
  if (ancestors.has(value)) return '[Circular]';

  ancestors.add(value);
  try {
    if (value instanceof Error) return normalizeError(value, ancestors);
    if (value instanceof Date) {
      return Number.isNaN(value.getTime())
        ? '[Invalid Date]'
        : value.toISOString();
    }
    if (value instanceof RegExp) return String(value);
    if (value instanceof URL) return value.href;
    if (value instanceof Map) {
      return {
        $type: 'Map',
        entries: [...value.entries()].map(([key, entryValue]) => [
          normalize(key, ancestors),
          normalize(entryValue, ancestors),
        ]),
      };
    }
    if (value instanceof Set) {
      return {
        $type: 'Set',
        values: [...value].map((entry) => normalize(entry, ancestors)),
      };
    }
    if (value instanceof ArrayBuffer) {
      return {
        $type: 'ArrayBuffer',
        values: [...new Uint8Array(value)],
      };
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      return {
        $type: value.constructor.name,
        values: [...bytes],
      };
    }
    if (Array.isArray(value)) {
      return value.map((entry) => normalize(entry, ancestors));
    }
    return normalizeObject(value, ancestors);
  } catch (error) {
    return `[Unserializable: ${errorMessage(error)}]`;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeError(
  error: Error,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  // Object.fromEntries defines every key as an own property, so an own
  // `__proto__` key stays a key instead of replacing the prototype.
  const entries: [string, unknown][] = [
    ['name', error.name],
    ['message', error.message],
  ];
  if (error.stack != null) entries.push(['stack', error.stack]);
  if (error.cause !== undefined) {
    entries.push(['cause', normalize(error.cause, ancestors)]);
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(error),
  )) {
    if (['name', 'message', 'stack', 'cause'].includes(key)) continue;
    entries.push([key, normalizeDescriptor(descriptor, ancestors)]);
  }
  return Object.fromEntries(entries);
}

function normalizeObject(
  value: object,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  const typeName = prototypeConstructorName(value);
  const entries: [string, unknown][] =
    typeName && typeName !== 'Object' ? [['$type', typeName]] : [];

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor == null) continue;
    entries.push([
      typeof key === 'symbol' ? String(key) : key,
      normalizeDescriptor(descriptor, ancestors),
    ]);
  }
  return Object.fromEntries(entries);
}

/**
 * Reads the constructor name from the prototype, not the value, so an own
 * `constructor` field is reported as data rather than as the type.
 */
function prototypeConstructorName(value: object): string | undefined {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    typeof prototype !== 'object' ||
    prototype === null ||
    !('constructor' in prototype)
  ) {
    return undefined;
  }
  const { constructor } = prototype;
  return typeof constructor === 'function' ? constructor.name : undefined;
}

function normalizeDescriptor(
  descriptor: PropertyDescriptor,
  ancestors: WeakSet<object>,
): unknown {
  if ('value' in descriptor) return normalize(descriptor.value, ancestors);
  const accessors = [
    descriptor.get == null ? null : 'Getter',
    descriptor.set == null ? null : 'Setter',
  ].filter(Boolean);
  return `[${accessors.join('/')}]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
