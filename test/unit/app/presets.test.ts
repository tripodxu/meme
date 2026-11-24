import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SANDBOX_SCENARIOS, WEB_PRESETS } from '../../../src/app/presets.js';
import { computeConfigHash, computeParamsHash } from '../../../src/core/config/hash.js';

interface P615Prereg {
  readonly manifest: {
    readonly clustering: {
      readonly cells: readonly {
        readonly cellKey: string;
        readonly fullConfigHash: string;
        readonly paramsHash: string;
      }[];
    };
  };
}

describe('前端预设冻结与 G6 D1 证据哈希绑定（07 §12）', () => {
  it('仅两体制代表预设为 calibrated=true，其余预设与沙盒剧本一律 calibrated=false', () => {
    const calibratedIds = WEB_PRESETS.filter((p) => p.calibrated).map((p) => p.id);
    expect(calibratedIds).toEqual(['regime1_pyramid', 'regime2_continuum']);
    for (const scenario of SANDBOX_SCENARIOS) {
      expect(scenario.calibrated).toBe(false);
    }
  });

  it('冻结预设的 configHash/paramsHash 与 P6-15 归档预注册逐位一致', () => {
    const prereg = JSON.parse(
      readFileSync(join(process.cwd(), 'out', 'p6-15-prereg.json'), 'utf8'),
    ) as P615Prereg;
    const cellA = prereg.manifest.clustering.cells.find((c) => c.cellKey === 'A-share100-w0');
    const cellB = prereg.manifest.clustering.cells.find((c) => c.cellKey === 'B-share50-w15');
    expect(cellA).toBeDefined();
    expect(cellB).toBeDefined();

    const r1 = WEB_PRESETS.find((p) => p.id === 'regime1_pyramid');
    const r2 = WEB_PRESETS.find((p) => p.id === 'regime2_continuum');
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();

    expect(r1?.policy).toBe('mock-weighted-v1');
    expect(r2?.policy).toBe('mock-weighted-v1');
    expect(computeConfigHash(r1!.config)).toBe(cellA?.fullConfigHash);
    expect(computeParamsHash(r1!.config)).toBe(cellA?.paramsHash);
    expect(computeConfigHash(r2!.config)).toBe(cellB?.fullConfigHash);
    expect(computeParamsHash(r2!.config)).toBe(cellB?.paramsHash);
  });
});
