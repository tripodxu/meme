#!/usr/bin/env node
/**
 * 密钥扫描（11 §2）：只扫描 git 入库文件，发现疑似 Jev Key 立即失败。
 *
 * 只打印文件:行号与规则名，**不打印匹配内容**；`.env` 被 .gitignore 忽略，
 * 不在 `git ls-files` 中，因此本脚本不会读取本机真实密钥。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 实际 Key 形如 `jv-` + 长串字母数字；文档里的 `jv-…` 不会命中。 */
export const SECRET_PATTERNS = [{ name: 'jev-key-literal', regex: /\bjv-[A-Za-z0-9]{20,}\b/g }];

/**
 * 返回命中位置（规则名 + 行号），不返回匹配文本。
 * 行号按 `\n` 计数，1 起。
 */
export function findSecretPatterns(text) {
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(text)) !== null) {
      const line = text.slice(0, match.index).split('\n').length;
      hits.push({ pattern: pattern.name, line });
    }
  }
  return hits;
}

function isProbablyBinary(buffer) {
  return buffer.includes(0);
}

function main() {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter((file) => file.length > 0);
  } catch {
    console.error('无法运行 git ls-files；请在仓库根目录执行');
    process.exit(2);
  }
  let hitCount = 0;
  for (const file of files) {
    let buffer;
    try {
      buffer = readFileSync(file);
    } catch {
      continue;
    }
    // 跳过二进制与大文件；密钥不会出现在 >2 MiB 的入库文本里。
    if (isProbablyBinary(buffer) || buffer.length > 2 * 1024 * 1024) {
      continue;
    }
    for (const hit of findSecretPatterns(buffer.toString('utf8'))) {
      console.error(`${file}:${hit.line} ${hit.pattern}`);
      hitCount += 1;
    }
  }
  if (hitCount > 0) {
    console.error(`发现 ${hitCount} 处疑似密钥；不得提交，立即轮换旧 Key（11 §2）`);
    process.exit(1);
  }
  console.log(`密钥扫描通过：${files.length} 个入库文件`);
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
