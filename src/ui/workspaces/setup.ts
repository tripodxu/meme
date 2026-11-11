import { mergeConfig, type DeepPartialConfig } from '../../core/config/defaults.js';
import { validateRunConfig } from '../../core/config/validate.js';
import type { RunConfig } from '../../core/config/types.js';
import { WEB_PRESETS } from '../../app/presets.js';
import { exceedsLiveSuggestion, LIVE_SUGGESTED_LIMITS } from '../../app/live-policy.js';
import { badge, card, field, h, table } from '../dom.js';
import { configPreview, numeric, type StratifyApp } from '../app.js';

export function renderSetup(root: HTMLElement, app: StratifyApp): void {
  const config = app.draftConfig;
  root.append(
    h('div', { class: 'span-8' }, [
      card('预设与参数', [
        h('p', {
          class: 'muted',
          text: 'G6 未通过，全部预设都是“未校准演示”。修改任何字段会立即标记为自定义；开始前会重新校验配置。',
        }),
        h(
          'div',
          { class: 'preset-grid', role: 'group', ariaLabel: '预设' },
          WEB_PRESETS.map((preset) =>
            h(
              'button',
              {
                class: 'preset',
                ariaPressed: String(app.selectedPresetId === preset.id),
                onClick: () => app.selectPreset(preset.id),
              },
              [
                h('strong', { text: preset.name }),
                h('span', { text: preset.description }),
                h('span', { text: `${preset.policy} · seed=${preset.seed}` }),
              ],
            ),
          ),
        ),
        h('div', { style: 'height:12px' }),
        h(
          'form',
          {
            class: 'form-grid',
            onSubmit: (event) => {
              event.preventDefault();
              app.start();
            },
          },
          [
            field(
              'seed',
              h('input', {
                id: 'setup-seed',
                type: 'text',
                value: app.draftSeed,
                onInput: (event) => {
                  app.updateDraft({ draftSeed: (event.target as HTMLInputElement).value });
                  updatePreview(app, preview);
                },
              }),
              'seed 不进入 configHash，但与 config 一起决定初始人口。',
            ),
            field(
              '决策策略',
              selectPolicy(app),
              'jev_live 只经同源 /api/jev 代理；Key 仅驻留内存，不写存储/导出。',
            ),
            ...liveFields(app),
            field(
              '初始人口',
              numberInput(
                'setup-population',
                config.population.initialPopulation,
                2,
                1000,
                (value) => {
                  updateConfig(app, { population: { initialPopulation: value } });
                  updatePreview(app, preview);
                },
              ),
              '浏览器 live 默认上限 40；结构实验建议使用本地 runner。',
            ),
            field(
              '总 tick',
              numberInput('setup-ticks', config.schedule.totalTicks, 1, 36500, (value) => {
                updateConfig(app, { schedule: { totalTicks: value } });
                updatePreview(app, preview);
              }),
            ),
            field(
              '决策间隔（日）',
              numberInput('setup-interval', config.decision.interval, 1, 365, (value) => {
                updateConfig(app, { decision: { interval: value } });
                updatePreview(app, preview);
              }),
            ),
            field(
              '初始年龄模式',
              selectInput(
                'setup-age-mode',
                [
                  ['uniform', 'uniform（年龄结构）'],
                  ['newborn', 'newborn（仅演示）'],
                ],
                config.population.initialAgeMode,
                (value) => {
                  updateConfig(app, {
                    population: { initialAgeMode: value as 'uniform' | 'newborn' },
                  });
                  updatePreview(app, preview);
                },
              ),
            ),
            field(
              '初始开放度 O',
              numberInput(
                'setup-openness',
                config.openness.initial,
                0,
                1,
                (value) => {
                  updateConfig(app, { openness: { initial: value } });
                  updatePreview(app, preview);
                },
                0.01,
              ),
            ),
            field(
              '位移准入份额',
              numberInput(
                'setup-share',
                config.ascent.displacementShare,
                0,
                1,
                (value) => {
                  updateConfig(app, { ascent: { displacementShare: value } });
                  updatePreview(app, preview);
                },
                0.01,
              ),
            ),
            field(
              '占用锚定权重',
              numberInput(
                'setup-scarcity',
                config.ascent.scarcityWeight,
                0,
                100,
                (value) => {
                  updateConfig(app, { ascent: { scarcityWeight: value } });
                  updatePreview(app, preview);
                },
                1,
              ),
            ),
            field(
              '风险特质 sigma',
              numberInput(
                'setup-risk-sigma',
                config.behavior.riskTraitSigma,
                0,
                1,
                (value) => {
                  updateConfig(app, { behavior: { riskTraitSigma: value } });
                  updatePreview(app, preview);
                },
                0.01,
              ),
            ),
            field(
              '跨层特质 sigma',
              numberInput(
                'setup-cross-sigma',
                config.behavior.crossClassTraitSigma,
                0,
                1,
                (value) => {
                  updateConfig(app, { behavior: { crossClassTraitSigma: value } });
                  updatePreview(app, preview);
                },
                0.01,
              ),
            ),
            field(
              '风险竞争敏感性',
              numberInput(
                'setup-risk-sensitivity',
                config.behavior.riskCompeteSensitivity,
                0,
                10,
                (value) => {
                  updateConfig(app, { behavior: { riskCompeteSensitivity: value } });
                  updatePreview(app, preview);
                },
                0.1,
              ),
            ),
            field(
              '跨层竞争敏感性',
              numberInput(
                'setup-cross-sensitivity',
                config.behavior.crossClassCompeteSensitivity,
                0,
                10,
                (value) => {
                  updateConfig(app, { behavior: { crossClassCompeteSensitivity: value } });
                  updatePreview(app, preview);
                },
                0.1,
              ),
            ),
          ],
        ),
        h('div', { class: 'actions-row', style: 'margin-top:16px' }, [
          h('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: '冻结配置并开始',
            onClick: () => app.start(),
          }),
          h('button', {
            class: 'btn',
            type: 'button',
            text: '单步 +1',
            onClick: () => app.step(),
          }),
          h('button', {
            class: 'btn btn-ghost',
            type: 'button',
            text: '重置当前 run',
            onClick: () => app.controller.reset(),
          }),
        ]),
        h('div', { id: 'setup-issues', style: 'margin-top:12px' }),
      ]),
    ]),
    h('div', { class: 'span-4' }, [
      card('预检与配置摘要', [
        h('div', { id: 'setup-preview' }, [previewContent(app, config)]),
        h('div', { style: 'height:12px' }),
        h('div', { class: 'notice notice-warn' }, [
          h('strong', { text: '未校准声明：' }),
          h('span', {
            text: '本页面所有预设与参数均未通过 docs/07 的结构验收。运行结果只能用于交互、回放与机制探索，不能表述为“已校准”或“结构已涌现”。',
          }),
        ]),
        h('div', { style: 'height:12px' }),
        h('div', { id: 'setup-scale' }, [scaleWarning(config)]),
        h('div', { style: 'height:12px' }),
        h('details', {}, [
          h('summary', { text: '配置 JSON（只读预览）' }),
          h('pre', {
            class: 'mono',
            style: 'max-height:220px;overflow:auto;font-size:11px;white-space:pre-wrap',
            text: JSON.stringify(config, null, 2),
          }),
        ]),
      ]),
    ]),
  );

  // 提交时把校验错误写到预检卡；不在这里自动启动，避免静默失败。
  const form = root.querySelector('form');
  form?.addEventListener('submit', () => {
    const result = validateRunConfig(app.draftConfig);
    const issues = root.querySelector('#setup-issues');
    if (issues === null) return;
    issues.replaceChildren();
    if (!result.ok) {
      const list = h('ul', { class: 'issue-list' });
      for (const issue of result.issues) {
        list.append(h('li', { text: `${issue.path}: ${issue.message}` }));
      }
      issues.append(
        h('div', { class: 'notice notice-danger' }, [
          h('strong', { text: '配置未通过校验，已阻止启动。' }),
          list,
        ]),
      );
      app.notify('配置未通过校验，未启动。');
    }
  });
}

const preview = 'setup-preview';

function previewContent(app: StratifyApp, config: RunConfig): HTMLElement {
  const hashes = configPreview(config);
  return h('div', {}, [
    table(
      ['字段', '值'],
      [
        ['人口 / tick', `${config.population.initialPopulation} / ${config.schedule.totalTicks}`],
        ['决策间隔', String(config.decision.interval)],
        ['策略', app.draftPolicy],
        ['configHash', h('span', { class: 'mono', text: hashes.configHash })],
        ['paramsHash', h('span', { class: 'mono', text: hashes.paramsHash })],
      ],
    ),
  ]);
}

function updatePreview(app: StratifyApp, id: string): void {
  const element = document.getElementById(id);
  if (element === null) return;
  element.replaceChildren(previewContent(app, app.draftConfig));
  const scale = document.getElementById('setup-scale');
  if (scale !== null) scale.replaceChildren(scaleWarning(app.draftConfig));
}

function updateConfig(app: StratifyApp, patch: DeepPartialConfig): void {
  try {
    const next = mergeConfig(app.draftConfig, patch);
    app.updateDraft({ draftConfig: next });
  } catch {
    // 合并失败时保留旧配置；字段级错误由启动前校验统一报告。
  }
}

function numberInput(
  id: string,
  value: number,
  min: number,
  max: number,
  onValue: (value: number) => void,
  step = 1,
): HTMLInputElement {
  return h('input', {
    id,
    type: 'number',
    value: String(value),
    min,
    max,
    step,
    onInput: (event) => {
      const raw = (event.target as HTMLInputElement).value;
      onValue(numeric(raw, value));
    },
  });
}

function selectInput(
  id: string,
  values: readonly (readonly [string, string])[],
  current: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const select = h('select', {
    id,
    onChange: (event) => onChange((event.target as HTMLSelectElement).value),
  });
  for (const [value, label] of values) {
    select.append(h('option', { value, text: label, selected: value === current }));
  }
  return select;
}

function selectPolicy(app: StratifyApp): HTMLSelectElement {
  const select = h('select', {
    id: 'setup-policy',
    onChange: (event) => {
      const value = (event.target as HTMLSelectElement).value as StratifyApp['draftPolicy'];
      app.updateDraft({ draftPolicy: value });
      app.render();
    },
  });
  for (const [value, label] of [
    ['mock-weighted-v1', 'mock-weighted-v1'],
    ['mock-weighted-v2', 'mock-weighted-v2（D2）'],
    ['random-uniform-v1', 'random-uniform-v1'],
    ['jev_live', 'jev_live（同源代理 · BYOK）'],
  ] as const) {
    select.append(h('option', { value, text: label, selected: value === app.draftPolicy }));
  }
  return select;
}

function liveFields(app: StratifyApp): HTMLElement[] {
  if (app.draftPolicy !== 'jev_live') return [];
  return [
    field(
      'Jev API Key（仅内存）',
      h('input', {
        id: 'setup-live-key',
        type: 'password',
        placeholder: app.liveApiKey.length > 0 ? '已填写（不会回显）' : 'jv-…',
        onInput: (event) => {
          app.liveApiKey = (event.target as HTMLInputElement).value;
        },
      }),
      '不写 localStorage/IndexedDB/导出 bundle；刷新页面即丢失。',
    ),
    field(
      '模型',
      h('input', {
        id: 'setup-live-model',
        type: 'text',
        value: app.liveModel,
        onInput: (event) => {
          app.liveModel = (event.target as HTMLInputElement).value.trim();
        },
      }),
      '必须在 Worker 的 JEV_ALLOWED_MODELS 中；服务端会再次校验。',
    ),
    field(
      '最大调用数',
      numberInput('setup-live-calls', app.liveMaxCalls, 1, 100_000, (value) => {
        app.liveMaxCalls = value;
      }),
      '跨本 run 所有个体决策；耗尽后 live run 停止。',
    ),
    field(
      '最大 input token（估算）',
      numberInput('setup-live-tokens', app.liveMaxInputTokens, 1_000, 100_000_000, (value) => {
        app.liveMaxInputTokens = value;
      }),
      '按 utf8-three-quarter-v1 估算，保守值由 Worker/runner 再核对。',
    ),
    field(
      '最长运行分钟',
      numberInput('setup-live-minutes', app.liveMaxMinutes, 1, 240, (value) => {
        app.liveMaxMinutes = value;
      }),
      '到点停止新调用；不会自动重跑。',
    ),
    ...(exceedsLiveSuggestion(app.draftConfig)
      ? [
          field(
            '超建议规模确认',
            h('label', { class: 'checkbox' }, [
              h('input', {
                id: 'setup-live-scale-confirm',
                type: 'checkbox',
                checked: app.liveScaleConfirmed,
                onChange: (event) => {
                  app.liveScaleConfirmed = (event.target as HTMLInputElement).checked;
                },
              }),
              h('span', {
                text: `我确认当前规模超过 ${LIVE_SUGGESTED_LIMITS.maxPopulation} 人 / ${LIVE_SUGGESTED_LIMITS.maxTicks} tick / 间隔 ${LIVE_SUGGESTED_LIMITS.minDecisionInterval} 的建议上限，并承担调用与等待成本。`,
              }),
            ]),
          ),
        ]
      : []),
    h('div', { class: 'notice notice-warn' }, [
      h('strong', { text: 'live 会产生真实调用与费用。' }),
      h('br'),
      h('span', {
        text: '浏览器只经同源 /api/jev 转发；认证/预算/熔断失败会停止 run，不会静默回退继续。',
      }),
    ]),
  ];
}

function scaleWarning(config: RunConfig): HTMLElement {
  const due = Math.ceil(config.schedule.totalTicks / Math.max(config.decision.interval, 1));
  const calls = due * config.population.initialPopulation;
  const large =
    config.population.initialPopulation > 40 ||
    config.schedule.totalTicks > 730 ||
    config.decision.interval < 30;
  return h('div', { class: `notice ${large ? 'notice-warn' : ''}` }, [
    h('strong', { text: '静态调用上界：' }),
    h('span', {
      text: `${calls.toLocaleString()} 次个体决策（${due.toLocaleString()} 个决策 tick × ${config.population.initialPopulation} 人）。`,
    }),
    h('br'),
    h('span', {
      class: 'muted',
      text: large
        ? '当前规模超过浏览器 live 建议范围；离线 mock 可以运行，但长实验请使用本地 runner。'
        : '当前规模在浏览器演示范围内。',
    }),
  ]);
}

export function setupBadges(config: RunConfig): HTMLElement[] {
  return [
    badge(`N=${config.population.initialPopulation}`, 'muted'),
    badge(`T=${config.schedule.totalTicks}`, 'muted'),
    badge(`Δt=${config.decision.interval}`, 'muted'),
  ];
}
