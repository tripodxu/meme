import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { computeConfigHash, computeParamsHash } from '../../../src/core/config/hash.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RULES_VERSION,
} from '../../../src/core/control/versions.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { computeInitialPopulationHash } from '../../../src/core/hash/state-hash.js';
import { deriveInitialPopulation } from '../../../src/core/init/population.js';
import { UPLOAD_BUNDLE_FILE_SCHEMA } from '../../../src/runner/upload-bundle.js';
import { loadUploadBundle } from '../../../src/runner/upload-bundle.js';

const SHA_ZERO = `sha256:${'0'.repeat(64)}`;
const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stratify-upload-'));
  dirs.push(dir);
  return dir;
}

function baseFile(): Record<string, unknown> {
  const config = createDemoConfig();
  const seed = 'seed-bundle-1';
  const population = deriveInitialPopulation(config, asSeed(seed));
  return {
    schemaVersion: UPLOAD_BUNDLE_FILE_SCHEMA,
    config,
    identity: {
      rulesVersion: RULES_VERSION,
      engineVersion: ENGINE_VERSION,
      decisionSchemaVersion: DECISION_SCHEMA_VERSION,
      policyVersion: config.decision.policy,
      promptVersion: null,
      requestedModel: null,
      seed,
      runtimeVersion: 'test-runtime',
      configHash: computeConfigHash(config),
      paramsHash: computeParamsHash(config),
      initialPopulationHash: computeInitialPopulationHash(asSeed(seed), population),
      codeSha: 'test-code-sha',
    },
    experiment: null,
    artifactProfile: 'metrics-only',
    finalTick: config.schedule.totalTicks - 1,
    endReason: 'scheduled',
    finalAliveCount: 1,
    expectedDueDecisions: 0,
    finalStateHash: SHA_ZERO,
    summaryHash: SHA_ZERO,
    agents: { path: 'agents.json' },
    artifacts: [
      { kind: 'metrics', chunkId: 'metrics-0', path: 'metrics.ndjson', startTick: 0 },
      { kind: 'final_state', chunkId: 'final-0', path: 'final.ndjson' },
    ],
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('P5b 上传清单加载器', () => {
  it('从相对路径读取 artifact 与 agents', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'bundle.json'), JSON.stringify(baseFile()));
    writeFileSync(
      join(dir, 'metrics.ndjson'),
      '{"tick":0,"aliveCount":1,"classCounts":[1,0,0,0,0],"gini":0,"medianValue":0,"top10Share":0,"mUp":0,"mDown":0,"segregation":0,"edgeCount":0,"openness":0.5,"deathCount":0,"competitionLoss":0,"competitionGain":0,"fallbackRate":0,"payloadHash":"' +
        SHA_ZERO +
        '"}\n',
    );
    writeFileSync(join(dir, 'final.ndjson'), '{"schemaVersion":"final-state-v1"}\n');
    writeFileSync(
      join(dir, 'agents.json'),
      JSON.stringify([
        {
          agentId: 'a0',
          alive: true,
          classIndex: 0,
          maxClassIndex: 4,
          value: 0,
          ge: 1,
          hard: 10,
          initialLife: 25550,
          remainingLife: 20000,
          deathTick: null,
          payloadHash: SHA_ZERO,
        },
      ]),
    );
    const bundle = loadUploadBundle(join(dir, 'bundle.json'));
    expect(bundle.artifacts).toHaveLength(2);
    expect(bundle.artifacts[0]?.startTick).toBe(0);
    expect(bundle.agents).toHaveLength(1);
    expect(bundle.finalAliveCount).toBe(1);
  });

  it('拒绝 .. 目录逃逸与缺失文件', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'outside.ndjson'), '{"tick":0}\n');
    const file = baseFile();
    const artifacts = file['artifacts'] as Record<string, unknown>[];
    artifacts[0] = { ...artifacts[0], path: '../outside.ndjson' };
    writeFileSync(join(dir, 'nested', 'bundle.json'), JSON.stringify(file));
    expect(() => loadUploadBundle(join(dir, 'nested', 'bundle.json'))).toThrow(/逃逸/);

    artifacts[0] = { ...artifacts[0], path: 'missing.ndjson' };
    writeFileSync(join(dir, 'nested', 'bundle.json'), JSON.stringify(file));
    expect(() => loadUploadBundle(join(dir, 'nested', 'bundle.json'))).toThrow(/不存在/);
  });

  it('拒绝未知 schemaVersion', () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, 'bundle.json'),
      JSON.stringify({ ...baseFile(), schemaVersion: 'run-upload-bundle-file-v0' }),
    );
    expect(() => loadUploadBundle(join(dir, 'bundle.json'))).toThrow(/schemaVersion/);
  });

  it('支持内联 agents 与 {agents:[]} 包装，并拒绝损坏 JSON 或空 artifact', () => {
    const dir = makeDir();
    expect(() => loadUploadBundle(join(dir, 'nope.json'))).toThrow(/不存在/);
    writeFileSync(join(dir, 'bad.json'), '{broken');
    expect(() => loadUploadBundle(join(dir, 'bad.json'))).toThrow(/合法 JSON/);
    writeFileSync(join(dir, 'arr.json'), '[]');
    expect(() => loadUploadBundle(join(dir, 'arr.json'))).toThrow(/对象/);

    writeFileSync(join(dir, 'metrics.ndjson'), '{"tick":0}\n');
    writeFileSync(join(dir, 'final.ndjson'), '{"schemaVersion":"final-state-v1"}\n');
    writeFileSync(join(dir, 'agents-wrapped.json'), JSON.stringify({ agents: [] }));

    const wrapped = {
      ...baseFile(),
      finalAliveCount: 0,
      agents: { path: 'agents-wrapped.json' },
    };
    writeFileSync(join(dir, 'wrapped.json'), JSON.stringify(wrapped));
    expect(loadUploadBundle(join(dir, 'wrapped.json')).agents).toEqual([]);

    const inline = { ...baseFile(), finalAliveCount: 0, agents: [] };
    writeFileSync(join(dir, 'inline.json'), JSON.stringify(inline));
    expect(loadUploadBundle(join(dir, 'inline.json')).agents).toEqual([]);

    writeFileSync(join(dir, 'empty.ndjson'), '   \n');
    const emptyArt = {
      ...inline,
      artifacts: [{ kind: 'metrics', chunkId: 'm0', path: 'empty.ndjson' }],
    };
    writeFileSync(join(dir, 'empty-bundle.json'), JSON.stringify(emptyArt));
    expect(() => loadUploadBundle(join(dir, 'empty-bundle.json'))).toThrow(/为空/);

    // 覆盖 agents 非法格式与空 artifacts 分支
    writeFileSync(join(dir, 'bad-agents.json'), '{nope');
    writeFileSync(
      join(dir, 'b1.json'),
      JSON.stringify({ ...baseFile(), agents: { path: 'bad-agents.json' } }),
    );
    expect(() => loadUploadBundle(join(dir, 'b1.json'))).toThrow(/agents 文件不是合法 JSON/);

    writeFileSync(join(dir, 'obj-agents.json'), '{"foo":1}');
    writeFileSync(
      join(dir, 'b2.json'),
      JSON.stringify({ ...baseFile(), agents: { path: 'obj-agents.json' } }),
    );
    expect(() => loadUploadBundle(join(dir, 'b2.json'))).toThrow(/agents 文件必须是数组/);

    writeFileSync(join(dir, 'b3.json'), JSON.stringify({ ...baseFile(), agents: 123 }));
    expect(() => loadUploadBundle(join(dir, 'b3.json'))).toThrow(/agents 必须是数组或 \{path\}/);

    writeFileSync(join(dir, 'b4.json'), JSON.stringify({ ...baseFile(), artifacts: [] }));
    expect(() => loadUploadBundle(join(dir, 'b4.json'))).toThrow(/artifacts 不得为空/);

    writeFileSync(
      join(dir, 'b5.json'),
      JSON.stringify({ ...baseFile(), artifacts: [{ kind: 'metrics', chunkId: 'm0' }] }),
    );
    expect(() => loadUploadBundle(join(dir, 'b5.json'))).toThrow(/缺少 path/);
  });
});
