import { existsSync } from 'node:fs';

import { chromium, defineConfig } from '@playwright/test';

function resolveChannel(): string | undefined {
  const envChannel = process.env['PLAYWRIGHT_CHANNEL'];
  if (envChannel !== undefined && envChannel !== '') return envChannel;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // 忽略未安装内置浏览器的探测异常
  }
  if (process.platform === 'win32') {
    if (existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')) {
      return 'msedge';
    }
    if (existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')) {
      return 'chrome';
    }
  }
  return undefined;
}

const channel = resolveChannel();

export default defineConfig({
  testDir: './test/e2e-browser',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5180',
    headless: true,
    ...(channel === undefined ? {} : { channel }),
  },
  webServer: {
    command: 'pnpm dev:web --host 127.0.0.1',
    url: 'http://127.0.0.1:5180',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
