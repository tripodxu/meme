import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * P5-06：systemd 标准部署的静态契约测试（docs/09 §6）。
 * unit 文件的必备键与本仓库可执行守卫脚本的行为在本机验证；
 * systemd 本身在 VPS 上按 deploy/README.md 安装演练。
 */
const deployDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deploy');
const unitText = readFileSync(join(deployDir, 'stratify-runner.service'), 'utf8');
const journaldText = readFileSync(join(deployDir, 'journald-stratify.conf'), 'utf8');

function unitValue(key: string): string | null {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(unitText);
  return match?.[1] ?? null;
}

describe('stratify-runner.service 静态契约（P5-06 / docs/09 §6）', () => {
  it('存在且 section 齐全', () => {
    expect(existsSync(join(deployDir, 'stratify-runner.service'))).toBe(true);
    expect(unitText).toContain('[Unit]');
    expect(unitText).toContain('[Service]');
    expect(unitText).toContain('[Install]');
  });

  it('没有 manifest 不自动启动（ConditionPathExists）', () => {
    expect(unitValue('ConditionPathExists')).toBe('/var/lib/stratify/manifests/current.json');
  });

  it('EnvironmentFile/WorkingDirectory/专用用户符合 docs/09 路径', () => {
    expect(unitValue('EnvironmentFile')).toBe('/etc/stratify/runner.env');
    expect(unitValue('WorkingDirectory')).toBe('/opt/stratify/current');
    expect(unitValue('User')).toBe('stratify-runner');
    expect(unitValue('User')).not.toBe('root');
  });

  it('Restart=on-failure 且限制重启频率', () => {
    expect(unitValue('Restart')).toBe('on-failure');
    expect(unitValue('StartLimitIntervalSec')).toBe('300');
    expect(unitValue('StartLimitBurst')).toBe('5');
  });

  it('ExecStart 固定批次 CLI：manifest + --resume + run 内检查点', () => {
    const execStart = unitValue('ExecStart');
    expect(execStart).not.toBeNull();
    expect(execStart).toContain('bin/stratify-batch.mjs');
    expect(execStart).toContain('/var/lib/stratify/manifests/current.json');
    expect(execStart).toContain('--resume');
    expect(execStart).toContain('--checkpoint-ticks 500');
    // 服务重启读取检查点续跑，不重新起批。
    expect(execStart).toContain('--out /var/lib/stratify/exports/current');
  });

  it('磁盘守卫作为 ExecStartPre（磁盘到阈值停止新批次）', () => {
    const execStartPre = unitValue('ExecStartPre');
    expect(execStartPre).toContain('/bin/bash');
    expect(execStartPre).toContain('check-disk-space.sh /var/lib/stratify 2048');
  });

  it('进程加固与非 root 最小权限', () => {
    expect(unitValue('NoNewPrivileges')).toBe('true');
    expect(unitValue('ProtectSystem')).toBe('strict');
    expect(unitValue('ReadWritePaths')).toBe('/var/lib/stratify');
    expect(unitValue('PrivateTmp')).toBe('true');
    expect(unitValue('ProtectHome')).toBe('true');
  });

  it('journald 大小与保留已配置（docs/09 §6）', () => {
    expect(journaldText).toContain('SystemMaxUse=200M');
    expect(journaldText).toContain('SystemKeepFree=1G');
    expect(journaldText).toContain('MaxRetentionSec=14day');
  });
});

const bashAvailable = (() => {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
})();

describe.runIf(bashAvailable)('check-disk-space.sh 行为（P5-06）', () => {
  const script = join(deployDir, 'check-disk-space.sh');

  it('充足阈值通过（exit 0）', () => {
    const result = spawnSync('bash', [script, deployDir, '0'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('磁盘检查通过');
  });

  it('不可达阈值拒绝（exit 1）', () => {
    const result = spawnSync('bash', [script, deployDir, '104857600'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('磁盘可用空间不足');
  });

  it('参数非法拒绝（exit 2）', () => {
    expect(spawnSync('bash', [script], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync('bash', [script, deployDir, 'abc'], { encoding: 'utf8' }).status).toBe(2);
    expect(
      spawnSync('bash', [script, 'Z:/definitely/not/exist', '10'], { encoding: 'utf8' }).status,
    ).toBe(2);
  });
});
