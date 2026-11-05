import { describe, expect, it } from 'vitest';

import { findSecretPatterns } from '../../../scripts/check-secrets.mjs';

describe('密钥扫描（11 §2）', () => {
  it('识别 jv- 长串 Key 并给出行号，不回显内容', () => {
    const text = ['const a = 1;', 'const key = "jv-abcdefghijklmnopqrstuvwx";'].join('\n');
    const hits = findSecretPatterns(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.pattern).toBe('jev-key-literal');
    expect(hits[0]?.line).toBe(2);
    expect(JSON.stringify(hits)).not.toContain('abcdefghijklmnopqrstuvwx');
  });

  it('文档占位符、环境变量名与普通 URL 不误报', () => {
    expect(findSecretPatterns('JEV_API_KEY=jv-…')).toEqual([]);
    expect(findSecretPatterns('JEV_API_KEY=<your-key>')).toEqual([]);
    expect(findSecretPatterns('https://jev.logicc.top/v1/systemone')).toEqual([]);
  });

  it('短于 20 位的示例串不命中', () => {
    expect(findSecretPatterns('jv-short-example')).toEqual([]);
  });
});
