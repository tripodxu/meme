import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RULES_VERSION } from '../../../src/core/control/versions.js';
import { CLAIMS } from '../../../src/ui/copy/claims.js';

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('科学声明与版本单一数据源（F0）', () => {
  it('CLAIMS.rulesVersion 与 core RULES_VERSION 保持一致', () => {
    expect(CLAIMS.rulesVersion).toBe(RULES_VERSION);
  });

  it('除 src/ui/copy/claims.ts 外，src/ui 不得硬编码 G6 声明或当前规则版本号', () => {
    const uiRoot = join(process.cwd(), 'src', 'ui');
    const files = walkTs(uiRoot);
    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(uiRoot, file).replaceAll('\\', '/');
      if (rel === 'copy/claims.ts') continue;
      const content = readFileSync(file, 'utf8');
      if (content.includes('G6')) {
        violations.push(`${rel}: contains hardcoded G6`);
      }
      if (content.includes(RULES_VERSION)) {
        violations.push(`${rel}: contains hardcoded ${RULES_VERSION}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
