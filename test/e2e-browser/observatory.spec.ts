import { expect, test } from '@playwright/test';

test.describe('P3-07 真实浏览器自动化 E2E（Chromium）', () => {
  test('桌面端完整推进、洛伦兹/剩余寿命图、快照跳转与 IndexedDB v3 刷新自动恢复', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.locator('.command-hud')).toBeVisible();

    // 切至参数实验台，调整为轻量规模 (N=12, T=8, Δt=2) 并启动运行
    await page.locator('#tab-setup').click();
    await page.locator('#setup-population').fill('12');
    await page.locator('#setup-ticks').fill('8');
    await page.locator('#setup-interval').fill('2');
    await page.getByRole('button', { name: '冻结配置并开始' }).click();

    await expect(page.locator('.status-beacon')).toContainText('已完成', { timeout: 10_000 });
    await expect(page.locator('svg[aria-label="阶级结构堆叠"]')).toBeVisible();
    await expect(page.locator('svg[aria-label="财富洛伦兹曲线"]')).toBeVisible();
    await expect(page.locator('svg[aria-label="存活个体剩余寿命直方图"]')).toBeVisible();

    const stackBox = await page.locator('svg[aria-label="阶级结构堆叠"]').boundingBox();
    expect(stackBox?.width ?? 0).toBeGreaterThan(200);
    expect(stackBox?.height ?? 0).toBeGreaterThan(100);
    await expect(page.locator('body')).not.toContainText('NaN');

    // 验证同标签页 IndexedDB v3 分块持久化与刷新自动恢复
    await expect
      .poll(async () => page.evaluate(() => sessionStorage.getItem('stratify.lastRunId.v1')), {
        timeout: 5_000,
      })
      .toMatch(/^local-/);
    const savedRunId = await page.evaluate(() => sessionStorage.getItem('stratify.lastRunId.v1'));

    await page.reload();
    await expect(page.locator('.notice-host')).toContainText('已自动恢复同标签页会话', {
      timeout: 8_000,
    });
    await page.locator('#tab-replay').click();
    await expect(page.locator('body')).toContainText(savedRunId ?? 'local-');

    // 测试历史周期快照点回滚跳转（时间轴快照 Popover）
    const snapBtn = page.getByRole('button', { name: /快照 \(/ });
    await expect(snapBtn).toBeEnabled();
    await snapBtn.click();
    await page.getByRole('button', { name: '跳转 Tick 0', exact: true }).click();
    await expect(page.locator('.status-beacon')).toContainText('已暂停');
    await expect(page.locator('.status-beacon')).toContainText('Tick 0 / 8');

    expect(errors).toEqual([]);
  });

  test('生态场 Canvas 舞台、玩家化身命运抉择卡与平行宇宙微扰分叉', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    // 默认首屏即为生态场，点击第一套探索卷宗开启手动化身探索
    const canvas = page.locator('canvas.arena-canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(300);
    expect(box?.height ?? 0).toBeGreaterThan(250);

    await page.locator('.scenario-card').first().click();
    const choiceBtn = page.locator('.choice-accumulate');
    await expect(choiceBtn).toBeVisible({ timeout: 8_000 });
    await choiceBtn.click();

    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('button', { name: '微扰分叉', exact: true }).click();

    await page.locator('#tab-replay').click();
    await expect(page.locator('body')).toContainText('平行宇宙微扰分叉溯源');
    await expect(page.locator('body')).toContainText('种子已配对');

    expect(errors).toEqual([]);
  });

  test('360px 窄屏无关键溢出、Firefox 非权威运行时提示与 Live 内存密钥护栏', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 740 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    });
    const page = await context.newPage();
    await page.goto('/');

    await page.locator('#tab-setup').click();

    // Firefox UA 必须触发 nonAuthoritativeRuntime 提示
    await expect(page.locator('body')).toContainText('nonAuthoritativeRuntime');

    // 360px 视口不得出现破坏性横向溢出
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(4);

    // jev_live 超规模阻断且密钥不落盘
    await page.locator('#setup-population').fill('50');
    await page.locator('#setup-policy').selectOption('jev_live');
    await page.locator('#setup-live-key').fill('pw-never-persist-secret-key');
    await page.getByRole('button', { name: '冻结配置并开始' }).click();
    await expect(page.locator('.notice-host')).toContainText('建议上限');

    const storageDump = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    expect(storageDump).not.toContain('pw-never-persist-secret-key');

    await context.close();
  });
});
