import type { RunConfig } from './types.js';

/**
 * 配置叶子路径差异（07 §6.2「每次只变一项」的机器校验基础）。
 *
 * 语义约定：
 * - 递归比较两棵配置树，只在**最末级**出现差异处记录一条点路径；
 * - 数组视为叶子（`needMultiplier`、`env0`、`decay` 等是向量参数，
 *   逐下标拆分会让「改一个向量」被误判成 5 个独立变量）；
 * - `undefined` 与「键不存在」等价，避免可选字段的写法差异制造伪差异。
 *
 * 该函数只用于预注册设计校验与产物自描述，不参与任何结算路径。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).filter((key) => a[key] !== undefined);
    const bKeys = Object.keys(b).filter((key) => b[key] !== undefined);
    return (
      aKeys.length === bKeys.length && aKeys.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

/** 返回 `variant` 相对 `base` 的差异叶子点路径（已排序，去重）。 */
export function diffConfigPaths(base: RunConfig, variant: RunConfig): readonly string[] {
  const paths: string[] = [];
  const walk = (a: unknown, b: unknown, prefix: string): void => {
    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        walk(a[key], b[key], prefix === '' ? key : `${prefix}.${key}`);
      }
      return;
    }
    if (!deepEqual(a, b)) {
      paths.push(prefix);
    }
  };
  walk(base, variant, '');
  return [...new Set(paths)].sort();
}
