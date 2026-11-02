import { errorCodes, StratifyError } from '../control/errors.js';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function reject(path: string, message: string): never {
  throw new StratifyError(errorCodes.HASH_NON_CANONICAL, message, [{ path }]);
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    reject(path, `不能对非有限数做 canonical JSON: ${String(value)}`);
  }
  if (Object.is(value, -0)) {
    return '0';
  }
  return String(value);
}

function serializeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) {
    reject(path, '字符串包含未配对的 UTF-16 代理项，RFC 8785 拒绝此类输入');
  }
  return JSON.stringify(value);
}

function isPlainObject(value: object): value is Record<string, JsonValue> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value, path);
    case 'string':
      return serializeString(value, path);
    case 'object':
      break;
    case 'undefined':
      reject(path, 'canonical JSON 不得包含 undefined');
      break;
    case 'bigint':
      reject(path, 'canonical JSON 不得包含 bigint');
      break;
    case 'function':
    case 'symbol':
      reject(path, `canonical JSON 不得包含 ${typeof value}`);
      break;
  }

  const objectValue = value as object;
  if (Array.isArray(objectValue)) {
    const parts = objectValue.map((item, index) => serialize(item, `${path}[${index}]`));
    return `[${parts.join(',')}]`;
  }

  if (!isPlainObject(objectValue)) {
    reject(path, 'canonical JSON 只接受纯对象');
  }

  const entries = Object.entries(objectValue);
  entries.sort(([a], [b]) => Number(a > b) - Number(a < b));
  const parts = entries.map(
    ([key, item]) => `${serializeString(key, path)}:${serialize(item, `${path}.${key}`)}`,
  );
  return `{${parts.join(',')}}`;
}

/**
 * RFC 8785 JSON Canonicalization Scheme。
 *
 * - 对象键按 UTF-16 码元升序；
 * - 数组顺序保持不变；
 * - 数字使用 ECMAScript 的 Number::toString 语义，`-0` 统一为 `0`；
 * - 非有限数、undefined、bigint、函数、符号、非纯对象与未配对代理项一律拒绝。
 */
export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    canonicalize(value);
    return true;
  } catch {
    return false;
  }
}

const utf8 = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return utf8.encode(text);
}
