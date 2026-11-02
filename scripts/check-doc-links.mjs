#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'tmp']);
const FENCED_CODE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^()\s]+)(?:\s+["'][^"']*["'])?\)/g;
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function collectMarkdownFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectMarkdownFiles(path, files);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path);
    }
  }
  return files;
}

/** 用等长空白替换围栏代码块，避免把示例代码里的链接当成真实链接，同时保留行号。 */
function maskFencedCode(content) {
  return content.replace(FENCED_CODE, (block) => block.replace(/[^\n]/g, ''));
}

function resolveTarget(file, rawTarget) {
  const path = rawTarget.split('#')[0].split('?')[0];
  if (path === '') return undefined;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // 非法百分号编码保持原样，交给存在性检查报告。
  }
  return decoded.startsWith('/')
    ? resolve(ROOT, decoded.slice(1))
    : resolve(dirname(file), decoded);
}

const files = collectMarkdownFiles(ROOT);
const problems = [];
let linkCount = 0;

for (const file of files) {
  const lines = maskFencedCode(readFileSync(file, 'utf8')).split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(MARKDOWN_LINK)) {
      const rawTarget = match[1];
      if (rawTarget === undefined || rawTarget.startsWith('#') || EXTERNAL_TARGET.test(rawTarget)) {
        continue;
      }
      const absolute = resolveTarget(file, rawTarget);
      if (absolute === undefined) continue;
      linkCount += 1;
      if (!existsSync(absolute)) {
        problems.push({
          file: relative(ROOT, file).split(sep).join('/'),
          line: index + 1,
          target: rawTarget,
        });
      }
    }
  });
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`${problem.file}:${problem.line} 链接目标不存在: ${problem.target}`);
  }
  console.error(`\n共 ${problems.length} 个失效链接，扫描 ${files.length} 个 Markdown 文件。`);
  process.exit(1);
}

console.log(`文档链接检查通过：${files.length} 个 Markdown 文件，${linkCount} 条相对链接。`);
