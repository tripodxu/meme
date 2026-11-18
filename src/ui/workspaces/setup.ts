import {
  DEFAULT_RUN_CONFIG,
  mergeConfig,
  type DeepPartialConfig,
} from '../../core/config/defaults.js';
import { diffConfigPaths } from '../../core/config/diff.js';
import { validateRunConfig } from '../../core/config/validate.js';
import type { RunConfig } from '../../core/config/types.js';
import { effortFunction } from '../../core/engine/settlement.js';
import { WEB_PRESETS } from '../../app/presets.js';
import { exceedsLiveSuggestion, LIVE_SUGGESTED_LIMITS } from '../../app/live-policy.js';
import { detectRuntimeAuthority, formatNumber } from '../../app/view-model.js';
import { renderSparkline } from '../charts/core.js';
import { badge, card, field, h, table } from '../dom.js';
import { configPreview, numeric, type StratifyApp } from '../app.js';

export function renderSetup(root: HTMLElement, app: StratifyApp): void {
  const config = app.draftConfig;
  const authority = detectRuntimeAuthority();

  const effortSparkHost = h('div', { class: 'spark-box' }, [buildEffortSpark(config)]);
  const envSparkHost = h('div', { class: 'spark-box' }, [buildEnvSpark(config)]);
  const previewHost = h('div', { id: 'setup-preview' }, [previewContent(app, config)]);
  const scaleHost = h('div', { id: 'setup-scale' }, [scaleWarning(app, config)]);
  const configJsonPre = h('pre', {
    class: 'mono code-preview',
    text: JSON.stringify(config, null, 2),
  });
  const issuesHost = h('div', { id: 'setup-issues', style: 'margin-top:12px' });

  const refreshSidecars = (): void => {
    const latest = app.draftConfig;
    previewHost.replaceChildren(previewContent(app, latest));
    scaleHost.replaceChildren(scaleWarning(app, latest));
    effortSparkHost.replaceChildren(buildEffortSpark(latest));
    envSparkHost.replaceChildren(buildEnvSpark(latest));
    configJsonPre.textContent = JSON.stringify(latest, null, 2);
  };

  // 顶部沙盒快捷入口横幅
  const heroBanner = h('div', { class: 'span-12 setup-hero' }, [
    h('div', { class: 'setup-hero-copy' }, [
      h('div', { class: 'actions-row' }, [
        badge('双引擎工作台', 'info'),
        badge(authority.label, authority.authoritative ? 'ok' : 'warn'),
        badge('G6 已通过（D1 两体制）', 'ok'),
      ]),
      h('h2', {
        class: 'setup-hero-title',
        text: '精密计算社会学试验台 × 沉浸式社会演化沙盒',
      }),
      h('p', {
        class: 'setup-hero-desc',
        text: '在此配置七维规则参数并启动对照试验，或一键切入「✦ 交互沙盒剧场」化身个体亲历阶层跃迁、社交重构与平行宇宙微扰分叉。',
      }),
    ]),
    h('div', { class: 'setup-hero-actions' }, [
      h('button', {
        class: 'btn btn-accent-glow',
        type: 'button',
        text: '✦ 进入交互沙盒剧场',
        onClick: () => app.setSurface('sandbox'),
      }),
      h('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: '▶ 冻结配置并启动试验',
        onClick: () => app.start(),
      }),
    ]),
  ]);

  const form = h(
    'form',
    {
      class: 'setup-sections',
      onSubmit: (event) => {
        event.preventDefault();
        const check = validateRunConfig(app.draftConfig);
        issuesHost.replaceChildren();
        if (!check.ok) {
          const list = h('ul', { class: 'issue-list' });
          for (const issue of check.issues) {
            list.append(h('li', { text: `${issue.path}: ${issue.message}` }));
          }
          issuesHost.append(
            h('div', { class: 'notice notice-danger' }, [
              h('strong', { text: '配置未通过校验，已阻止启动。' }),
              list,
            ]),
          );
          app.notify('配置未通过校验，未启动。');
          return;
        }
        app.start();
      },
    },
    [
      // 分组 1：核心规模、种子与决策策略（默认展开，包含所有常用与 E2E 核心控件）
      h('details', { class: 'param-group', open: true }, [
        h('summary', { class: 'param-group-summary' }, [
          h('span', { text: '01 · 基础规模、随机种子与决策引擎' }),
          badge('核心必配', 'info'),
        ]),
        h('div', { class: 'form-grid param-group-body' }, [
          field(
            '随机种子 (seed)',
            h('input', {
              id: 'setup-seed',
              type: 'text',
              value: app.draftSeed,
              onInput: (event) => {
                app.updateDraft({ draftSeed: (event.target as HTMLInputElement).value });
                refreshSidecars();
              },
            }),
            'seed 独立于 configHash，与 config 纯函数派生初始人口与网络。',
          ),
          field(
            '决策策略 (policy)',
            selectPolicy(app),
            '离线 mock/random 零哈希高速推进；jev_live 经同源 /api/jev 转发。',
          ),
          ...liveFields(app, refreshSidecars),
          field(
            '初始人口 (N)',
            numberInput('setup-population', config.population.initialPopulation, 2, 1000, (val) => {
              updateConfig(app, { population: { initialPopulation: val } });
              refreshSidecars();
            }),
            '建议交互规模 40–200；千人长周期亦可在离线策略下流畅推进。',
          ),
          field(
            '计划总时长 (totalTicks)',
            numberInput('setup-ticks', config.schedule.totalTicks, 1, 36500, (val) => {
              const safeVal = Math.max(1, Math.round(val));
              const cur = app.draftConfig.schedule;
              updateConfig(app, {
                schedule: {
                  totalTicks: safeVal,
                  statsStride: Math.min(cur.statsStride, safeVal),
                  snapshotStride: Math.min(
                    cur.snapshotStride,
                    Math.max(1, Math.floor(safeVal / 2)),
                  ),
                },
              });
              refreshSidecars();
            }),
            '1 tick = 1 日；3650 tick 对应 10 年评估周期。',
          ),
          field(
            '决策间隔（日）',
            numberInput('setup-interval', config.decision.interval, 1, 365, (val) => {
              updateConfig(app, { decision: { interval: val } });
              refreshSidecars();
            }),
            '每隔 Δt 日枚举合法行动并结算主动跨越/竞争与网络重连。',
          ),
          field(
            '初始年龄分布',
            selectInput(
              'setup-age-mode',
              [
                ['uniform', 'uniform（均衡年龄结构）'],
                ['newborn', 'newborn（全员新生对照）'],
              ],
              config.population.initialAgeMode,
              (val) => {
                updateConfig(app, {
                  population: { initialAgeMode: val as 'uniform' | 'newborn' },
                });
                refreshSidecars();
              },
            ),
          ),
          field(
            '代际更替模式 (rules-v16)',
            selectInput(
              'setup-generational-mode',
              [
                ['none', 'none（无出生 · 与 v15 一致）'],
                ['replace', 'replace（1:1 死亡替补）'],
              ],
              config.population.generationalMode,
              (val) => {
                updateConfig(app, {
                  population: { generationalMode: val as 'none' | 'replace' },
                });
                refreshSidecars();
              },
            ),
          ),
          field(
            '遗产折算率 (bequestRate)',
            numberInput(
              'setup-bequest-rate',
              config.population.bequestRate,
              0,
              1,
              (val) => {
                updateConfig(app, { population: { bequestRate: val } });
                refreshSidecars();
              },
              0.05,
            ),
          ),
          field(
            '出身阶级继承率 (classInheritanceRate)',
            numberInput(
              'setup-class-inheritance',
              config.population.classInheritanceRate,
              0,
              1,
              (val) => {
                updateConfig(app, { population: { classInheritanceRate: val } });
                refreshSidecars();
              },
              0.05,
            ),
          ),
        ]),
      ]),

      // 分组 2：阶级机会、需求参照系与准入壁垒
      h('details', { class: 'param-group', open: true }, [
        h('summary', { class: 'param-group-summary' }, [
          h('span', { text: '02 · 阶级持有成本、上升壁垒与制度开放度' }),
          envSparkHost,
        ]),
        h('div', { class: 'form-grid param-group-body' }, [
          field(
            '初始开放度 O(0)',
            numberInput(
              'setup-openness',
              config.openness.initial,
              0,
              1,
              (val) => {
                updateConfig(app, { openness: { initial: val } });
                refreshSidecars();
              },
              0.01,
            ),
          ),
          field(
            '开放度演化模式',
            selectInput(
              'setup-openness-mode',
              [
                ['dynamic', 'dynamic（慢变量内生反馈）'],
                ['fixed', 'fixed（消融：恒定初始值）'],
              ],
              config.openness.updateMode,
              (val) => {
                updateConfig(app, {
                  openness: { updateMode: val as 'dynamic' | 'fixed' },
                });
                refreshSidecars();
              },
            ),
          ),
          field(
            '需求跌落阈值 (threshold)',
            numberInput(
              'setup-need-threshold',
              config.need.threshold,
              0,
              2,
              (val) => {
                updateConfig(app, { need: { threshold: val } });
                refreshSidecars();
              },
              0.05,
            ),
            'Value < threshold × need 时累计连续低于需求天数。',
          ),
          field(
            '被动跌落容忍天数',
            numberInput('setup-below-limit', config.need.belowNeedLimit, 1, 365, (val) => {
              updateConfig(app, { need: { belowNeedLimit: val } });
              refreshSidecars();
            }),
          ),
          field(
            '位移准入份额 (share)',
            numberInput(
              'setup-share',
              config.ascent.displacementShare,
              0,
              1,
              (val) => {
                updateConfig(app, { ascent: { displacementShare: val } });
                refreshSidecars();
              },
              0.05,
            ),
            '1=完全守擂对决位移；0=开放准入不挤下在位者。',
          ),
          field(
            '占用锚定权重 (scarcity)',
            numberInput(
              'setup-scarcity',
              config.ascent.scarcityWeight,
              0,
              100,
              (val) => {
                updateConfig(app, { ascent: { scarcityWeight: val } });
                refreshSidecars();
              },
              0.5,
            ),
            '目标层超编时额外抬升的上升余额门槛权重。',
          ),
          field(
            '持有裕度天数 (ρ)',
            numberInput('setup-cushion', config.ascent.holdingCushionDays, 0, 365, (val) => {
              updateConfig(app, { ascent: { holdingCushionDays: val } });
              refreshSidecars();
            }),
          ),
          field(
            '需求参照系',
            selectInput(
              'setup-ref-mode',
              [
                ['class', 'class（当期阶级参照收入 EMA）'],
                ['own', 'own（个体历史基准积分 v5）'],
              ],
              config.need.referenceMode,
              (val) => {
                updateConfig(app, {
                  need: { referenceMode: val as 'class' | 'own' },
                });
                refreshSidecars();
              },
            ),
          ),
        ]),
      ]),

      // 分组 3：个体特质异质性（D2）与努力曲线
      h('details', { class: 'param-group' }, [
        h('summary', { class: 'param-group-summary' }, [
          h('span', { text: '03 · 个体先天分布、努力曲线与行为异质性 (D2)' }),
          effortSparkHost,
        ]),
        h('div', { class: 'form-grid param-group-body' }, [
          field(
            '努力函数曲率 (effort.shape)',
            numberInput(
              'setup-effort-shape',
              config.effort.shape,
              0.1,
              5,
              (val) => {
                updateConfig(app, { effort: { shape: val } });
                refreshSidecars();
              },
              0.1,
            ),
          ),
          field(
            '天赋离散度 (ge.sigma)',
            numberInput(
              'setup-ge-sigma',
              config.attributes.ge.sigma,
              0,
              2,
              (val) => {
                updateConfig(app, {
                  attributes: { ge: { ...app.draftConfig.attributes.ge, sigma: val } },
                });
                refreshSidecars();
              },
              0.05,
            ),
          ),
          field(
            '风险特质 sigma',
            numberInput(
              'setup-risk-sigma',
              config.behavior.riskTraitSigma,
              0,
              1,
              (val) => {
                updateConfig(app, { behavior: { riskTraitSigma: val } });
                refreshSidecars();
              },
              0.05,
            ),
          ),
          field(
            '跨层特质 sigma',
            numberInput(
              'setup-cross-sigma',
              config.behavior.crossClassTraitSigma,
              0,
              1,
              (val) => {
                updateConfig(app, { behavior: { crossClassTraitSigma: val } });
                refreshSidecars();
              },
              0.05,
            ),
          ),
          field(
            '风险竞争敏感性',
            numberInput(
              'setup-risk-sensitivity',
              config.behavior.riskCompeteSensitivity,
              0,
              10,
              (val) => {
                updateConfig(app, { behavior: { riskCompeteSensitivity: val } });
                refreshSidecars();
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
              (val) => {
                updateConfig(app, { behavior: { crossClassCompeteSensitivity: val } });
                refreshSidecars();
              },
              0.1,
            ),
          ),
        ]),
      ]),

      // 分组 4：竞争转移、社交网络与宏观反馈指数
      h('details', { class: 'param-group' }, [
        h('summary', { class: 'param-group-summary' }, [
          h('span', { text: '04 · 竞争博弈损耗、网络重连与宏观反馈指数 (β / η / κ)' }),
          badge('高级机制旋钮', 'muted'),
        ]),
        h('div', { class: 'form-grid param-group-body' }, [
          field(
            '败者损失率 (lossRate)',
            numberInput(
              'setup-loss-rate',
              config.competition.lossRate,
              0,
              1,
              (val) => {
                updateConfig(app, { competition: { lossRate: val } });
                refreshSidecars();
              },
              0.01,
            ),
          ),
          field(
            '基础传递效率 (efficiency)',
            numberInput(
              'setup-transfer-eff',
              config.competition.baseTransferEfficiency,
              0,
              1,
              (val) => {
                updateConfig(app, { competition: { baseTransferEfficiency: val } });
                refreshSidecars();
              },
              0.05,
            ),
          ),
          field(
            '网络机会弹性 (β)',
            numberInput(
              'setup-beta',
              config.networkOpportunity.beta,
              0,
              2,
              (val) => {
                updateConfig(app, { networkOpportunity: { beta: val } });
                refreshSidecars();
              },
              0.05,
            ),
          ),
          field(
            '重连概率 (rewireProb)',
            numberInput(
              'setup-rewire-prob',
              config.network.rewireProb,
              0,
              1,
              (val) => {
                updateConfig(app, { network: { rewireProb: val } });
                refreshSidecars();
              },
              0.01,
            ),
          ),
          field(
            '阶级拥挤指数 (η)',
            numberInput(
              'setup-eta',
              config.dynamics.congestionExponent,
              0,
              2,
              (val) => {
                updateConfig(app, { dynamics: { congestionExponent: val } });
                refreshSidecars();
              },
              0.05,
            ),
          ),
          field(
            '财富极化指数 (κ)',
            numberInput(
              'setup-kappa',
              config.dynamics.polarizationExponent,
              0,
              2,
              (val) => {
                updateConfig(app, { dynamics: { polarizationExponent: val } });
                refreshSidecars();
              },
              0.05,
            ),
          ),
        ]),
      ]),

      // 分组 5：五阶层向量参数与制度滞回细节（06 §3 高阶研究展开）
      h('details', { class: 'param-group' }, [
        h('summary', { class: 'param-group-summary' }, [
          h('span', { text: '05 · 五阶层向量参数与制度滞回细节 (Vectors & Hysteresis)' }),
          badge('向量与高阶', 'muted'),
        ]),
        h('div', { class: 'param-group-body' }, [
          classSharesEditor(app, config, refreshSidecars),
          vectorRowEditor(
            '阶级基准机会向量 env0[0..4]',
            'setup-env0',
            ['C0', 'C1', 'C2', 'C3', 'C4'],
            config.opportunity.env0,
            0.01,
            1000,
            0.1,
            (next) => {
              updateConfig(app, { opportunity: { env0: next } });
              refreshSidecars();
            },
          ),
          vectorRowEditor(
            '每日寿命衰减向量 decay[0..4]',
            'setup-decay',
            ['C0', 'C1', 'C2', 'C3', 'C4'],
            config.lifespan.decay,
            0.05,
            10,
            0.05,
            (next) => {
              updateConfig(app, { lifespan: { decay: next } });
              refreshSidecars();
            },
          ),
          vectorRowEditor(
            '需求持有乘子向量 ψ[0..4]（ψ[0] 恒为 1）',
            'setup-psi',
            ['ψ0', 'ψ1', 'ψ2', 'ψ3', 'ψ4'],
            config.need.needMultiplier,
            0.1,
            100,
            0.1,
            (next) => {
              const locked = [1, ...next.slice(1)];
              updateConfig(app, { need: { needMultiplier: locked } });
              refreshSidecars();
            },
            new Set([0]),
          ),
          vectorRowEditor(
            '相邻上升基准天数 crossDays[0→1..3→4]',
            'setup-cross-days',
            ['0→1', '1→2', '2→3', '3→4'],
            config.ascent.crossDays,
            0,
            3650,
            1,
            (next) => {
              updateConfig(app, { ascent: { crossDays: next } });
              refreshSidecars();
            },
          ),
          vectorRowEditor(
            '阶级结构性容量上限 classCapacity[0..4] (rules-v17)',
            'setup-class-capacity',
            ['C0', 'C1', 'C2', 'C3', 'C4'],
            config.ascent.classCapacity,
            0.01,
            1,
            0.05,
            (next) => {
              updateConfig(app, { ascent: { classCapacity: next } });
              refreshSidecars();
            },
          ),
          vectorRowEditor(
            '重返原层折扣向量 returnDiscount[d=1..3]',
            'setup-return-discount',
            ['d=1', 'd=2', 'd=3'],
            config.ascent.returnDiscount,
            0,
            1,
            0.05,
            (next) => {
              updateConfig(app, { ascent: { returnDiscount: next } });
              refreshSidecars();
            },
          ),
          h('div', { class: 'form-grid', style: 'margin-top:12px' }, [
            field(
              '候选竞争对象上限 (topK)',
              numberInput('setup-topk', config.decision.topK, 1, 20, (val) => {
                updateConfig(app, { decision: { topK: val } });
                refreshSidecars();
              }),
            ),
            field(
              '需求标尺天数 (bufferDays)',
              numberInput('setup-buffer-days', config.need.bufferDays, 1, 3650, (val) => {
                updateConfig(app, { need: { bufferDays: val } });
                refreshSidecars();
              }),
            ),
            field(
              'class 判定宽限天数 (graceDays)',
              numberInput('setup-grace-days', config.need.graceDays, 0, 365, (val) => {
                updateConfig(app, { need: { graceDays: val } });
                refreshSidecars();
              }),
            ),
            field(
              '主动下降费用天数 (descent.days)',
              numberInput('setup-descent-days', config.descent.days, 0, 365, (val) => {
                updateConfig(app, { descent: { days: val } });
                refreshSidecars();
              }),
            ),
            field(
              '努力寿命损耗因子 (hardLifeFactor)',
              numberInput(
                'setup-hard-life-factor',
                config.lifespan.hardLifeFactor,
                0,
                2,
                (val) => {
                  updateConfig(app, { lifespan: { hardLifeFactor: val } });
                  refreshSidecars();
                },
                0.05,
              ),
            ),
            field(
              '占用记忆天数 H (occupancyMemoryDays)',
              numberInput(
                'setup-occupancy-memory',
                config.ascent.occupancyMemoryDays,
                0,
                3650,
                (val) => {
                  updateConfig(app, { ascent: { occupancyMemoryDays: val } });
                  refreshSidecars();
                },
              ),
            ),
            field(
              '开放度自反馈权重 (θH)',
              numberInput(
                'setup-self-reinforcement',
                config.openness.selfReinforcement,
                0,
                20,
                (val) => {
                  updateConfig(app, { openness: { selfReinforcement: val } });
                  refreshSidecars();
                },
                0.5,
              ),
            ),
            field(
              '制度状态机模式 (regimeMode)',
              selectInput(
                'setup-regime-mode',
                [
                  ['continuous', 'continuous（连续光滑更新）'],
                  ['hysteresis', 'hysteresis（显式双态迟滞机）'],
                ],
                config.openness.regimeMode,
                (val) => {
                  updateConfig(app, {
                    openness: { regimeMode: val as 'continuous' | 'hysteresis' },
                  });
                  refreshSidecars();
                },
              ),
            ),
            field(
              '制度偏置 (θR)',
              numberInput(
                'setup-regime-bias',
                config.openness.regimeBias,
                0,
                20,
                (val) => {
                  updateConfig(app, { openness: { regimeBias: val } });
                  refreshSidecars();
                },
                0.5,
              ),
            ),
          ]),
        ]),
      ]),
    ],
  );

  root.append(
    heroBanner,
    h('div', { class: 'span-8' }, [
      card('实验预设与七维参数台', [
        h('p', {
          class: 'muted',
          style: 'margin-top:0',
          text: 'D1“2 体制 + 连续统”已通过 P6-09 + R4 校准；带“已校准 (D1)”徽章的预设已冻结（仅限 mock-weighted-v1 / N=200），其余预设仍为未校准探索。修改任何字段会自动标记为自定义。',
        }),
        h(
          'div',
          { class: 'preset-grid', role: 'group', ariaLabel: '预设' },
          WEB_PRESETS.map((preset) =>
            h(
              'button',
              {
                class: 'preset',
                type: 'button',
                ariaPressed: String(app.selectedPresetId === preset.id),
                onClick: () => app.selectPreset(preset.id),
              },
              [
                h('div', { class: 'preset-top' }, [
                  h('strong', { text: preset.name }),
                  badge(
                    preset.calibrated ? '已校准 (D1)' : '未校准',
                    preset.calibrated ? 'ok' : 'warn',
                  ),
                ]),
                h('span', { text: preset.description }),
                h('span', {
                  class: 'mono',
                  text: `${preset.policy} · N=${preset.config.population.initialPopulation} · T=${preset.config.schedule.totalTicks}`,
                }),
              ],
            ),
          ),
        ),
        h('div', { style: 'height:14px' }),
        form,
        h('div', { class: 'actions-row', style: 'margin-top:16px' }, [
          h('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: '▶ 冻结配置并开始',
            onClick: () => app.start(),
          }),
          h('button', {
            class: 'btn',
            type: 'button',
            text: '⏭ 单步 +1',
            onClick: () => app.step(),
          }),
          h('button', {
            class: 'btn',
            type: 'button',
            text: '✦ 在沙盒剧场启动',
            onClick: () => {
              app.start('sandbox');
            },
          }),
          h('button', {
            class: 'btn btn-ghost',
            type: 'button',
            text: '↺ 重置当前 run',
            onClick: () => app.controller.reset(),
          }),
        ]),
        issuesHost,
      ]),
    ]),
    h('div', { class: 'span-4' }, [
      h('div', { class: 'sticky-cockpit' }, [
        card('预检舱与权威指纹摘要', [
          previewHost,
          h('div', { style: 'height:12px' }),
          scaleHost,
          h('div', { style: 'height:12px' }),
          !authority.authoritative
            ? h('div', { class: 'notice notice-warn', style: 'margin-bottom:12px' }, [
                h('strong', { text: 'nonAuthoritativeRuntime：' }),
                h('span', { text: authority.detail }),
              ])
            : null,
          h('div', { class: 'notice notice-warn' }, [
            h('strong', { text: '科学验收边界：' }),
            h('span', {
              text: 'D1“2 体制 + 连续统”已在 rules-v16 / N=200 / mock-weighted-v1 下通过 P6-09 与 R4 闭环；传统 k≥3 离散结构与 Jev 因果对照仍未通过，不得外推为“三态涌现”或现实因果。',
            }),
          ]),
          h('div', { style: 'height:12px' }),
          h('details', {}, [
            h('summary', {
              class: 'muted',
              style: 'cursor:pointer;font-size:12px',
              text: '展开冻结前完整 RunConfig JSON',
            }),
            configJsonPre,
          ]),
        ]),
      ]),
    ]),
  );
}

function buildEffortSpark(config: RunConfig): SVGSVGElement {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const hard = 0.2 + (2.8 * i) / 24;
    let y = hard;
    try {
      y = effortFunction(config.effort.shape, hard);
    } catch {
      y = hard;
    }
    pts.push({ x: hard, y });
  }
  return renderSparkline(pts, {
    width: 132,
    height: 34,
    color: 'var(--accent)',
    label: '努力函数 F(hard) 形态预览',
  });
}

function buildEnvSpark(config: RunConfig): SVGSVGElement {
  const pts = config.opportunity.env0.map((env, idx) => ({
    x: idx,
    y: env * (config.need.needMultiplier[idx] ?? 1),
  }));
  return renderSparkline(pts, {
    width: 132,
    height: 34,
    color: 'var(--gold)',
    label: '阶级基准持有尺度预览',
  });
}

function previewContent(app: StratifyApp, config: RunConfig): HTMLElement {
  const check = validateRunConfig(config);
  const diffPaths = check.ok ? diffConfigPaths(DEFAULT_RUN_CONFIG, check.config) : [];
  let hashSummary = { configHash: '待修正配置错误', paramsHash: '—' };
  if (check.ok) {
    try {
      hashSummary = configPreview(check.config);
    } catch {
      hashSummary = { configHash: '—', paramsHash: '—' };
    }
  }
  const activePreset = WEB_PRESETS.find((preset) => preset.id === app.selectedPresetId);
  const isCalibratedPreset = activePreset?.calibrated === true;
  return h('div', {}, [
    h('div', { class: 'actions-row', style: 'margin-bottom:8px' }, [
      badge(
        app.selectedPresetId === 'custom'
          ? '自定义 · 未校准'
          : isCalibratedPreset
            ? `预设:${app.selectedPresetId} · 已校准 (D1)`
            : `预设:${app.selectedPresetId} · 未校准`,
        isCalibratedPreset ? 'ok' : 'warn',
      ),
      badge(`差异字段 ${diffPaths.length}`, diffPaths.length > 0 ? 'info' : 'muted'),
    ]),
    table(
      ['审计项', '当前值'],
      [
        [
          '规模 (N × T)',
          `${config.population.initialPopulation} 人 × ${config.schedule.totalTicks} tick`,
        ],
        ['决策周期 Δt', `每 ${config.decision.interval} tick`],
        ['选定策略', app.draftPolicy],
        [
          'configHash',
          h('span', {
            class: 'mono',
            text: `${hashSummary.configHash.slice(0, 22)}…`,
            title: hashSummary.configHash,
          }),
        ],
        [
          'paramsHash',
          h('span', {
            class: 'mono',
            text: `${hashSummary.paramsHash.slice(0, 22)}…`,
            title: hashSummary.paramsHash,
          }),
        ],
      ],
    ),
    diffPaths.length === 0
      ? null
      : h('div', { class: 'diff-pills', style: 'margin-top:8px' }, [
          h('span', { class: 'muted', style: 'font-size:11px', text: '相对默认配置变更：' }),
          ...diffPaths.slice(0, 8).map((p) => badge(p, 'muted')),
          diffPaths.length > 8 ? badge(`+${diffPaths.length - 8} 项`, 'muted') : null,
        ]),
  ]);
}

function updateConfig(app: StratifyApp, patch: DeepPartialConfig): void {
  try {
    const next = mergeConfig(app.draftConfig, patch);
    app.updateDraft({ draftConfig: next });
  } catch {
    // 合并异常保留旧草案，由校验器统一提示
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
  }) as HTMLInputElement;
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
  }) as HTMLSelectElement;
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
  }) as HTMLSelectElement;
  for (const [value, label] of [
    ['mock-weighted-v1', 'mock-weighted-v1（确定性先验 v1）'],
    ['mock-weighted-v2', 'mock-weighted-v2（个体特质异质性 D2）'],
    ['random-uniform-v1', 'random-uniform-v1（均匀随机基线）'],
    ['jev_live', 'jev_live（同源代理 · BYOK 实时模型）'],
  ] as const) {
    select.append(h('option', { value, text: label, selected: value === app.draftPolicy }));
  }
  return select;
}

function classSharesEditor(
  app: StratifyApp,
  config: RunConfig,
  onRefresh: () => void,
): HTMLElement {
  const sumLabel = h('span', { class: 'mono muted', style: 'font-size:11px' });
  const updateSumText = (shares: readonly number[]): void => {
    const sum = shares.reduce((acc, item) => acc + item, 0);
    const ok = Math.abs(sum - 1) <= 1e-6;
    sumLabel.textContent = `Σ=${sum.toFixed(4)} ${ok ? '✓' : '（需等于 1）'}`;
    sumLabel.style.color = ok ? 'var(--status-ok)' : 'var(--status-warn)';
  };
  updateSumText(config.population.classShares);

  const inputs: HTMLInputElement[] = [];
  const row = h('div', { class: 'vector-row' });
  config.population.classShares.forEach((share, idx) => {
    const input = numberInput(
      `setup-share-c${idx}`,
      share,
      0,
      1,
      (val) => {
        const current = [...app.draftConfig.population.classShares];
        current[idx] = val;
        updateConfig(app, { population: { classShares: current } });
        updateSumText(current);
        onRefresh();
      },
      0.01,
    );
    inputs.push(input);
    row.append(
      h('label', { class: 'vector-cell' }, [
        h('span', { class: 'mono muted', text: `C${idx}` }),
        input,
      ]),
    );
  });

  return h('div', { class: 'vector-editor-block' }, [
    h('div', { class: 'actions-row', style: 'justify-content:space-between;margin-bottom:4px' }, [
      h('span', { class: 'field-label', text: '初始阶级占比向量 classShares[0..4]' }),
      h('div', { class: 'actions-row' }, [
        sumLabel,
        h('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          text: '一键归一化',
          onClick: () => {
            const raw = app.draftConfig.population.classShares;
            const total = raw.reduce((s, v) => s + Math.max(0, v), 0);
            const normalized =
              total > 0
                ? raw.map((v, i) =>
                    i === raw.length - 1 ? 0 : Number((Math.max(0, v) / total).toFixed(4)),
                  )
                : [0.4, 0.3, 0.18, 0.09, 0.03];
            if (total > 0 && normalized.length > 0) {
              const headSum = normalized.slice(0, -1).reduce((s, v) => s + v, 0);
              normalized[normalized.length - 1] = Number(Math.max(0, 1 - headSum).toFixed(4));
            }
            normalized.forEach((v, idx) => {
              const inp = inputs[idx];
              if (inp !== undefined) inp.value = String(v);
            });
            updateConfig(app, { population: { classShares: normalized } });
            updateSumText(normalized);
            onRefresh();
          },
        }),
      ]),
    ]),
    row,
  ]);
}

function vectorRowEditor(
  label: string,
  idPrefix: string,
  slotLabels: readonly string[],
  values: readonly number[],
  min: number,
  max: number,
  step: number,
  onVector: (next: number[]) => void,
  readOnlyIndices: ReadonlySet<number> = new Set(),
): HTMLElement {
  const currentVec = [...values];
  const row = h('div', { class: 'vector-row' });
  values.forEach((val, idx) => {
    const input = numberInput(
      `${idPrefix}-${idx}`,
      val,
      min,
      max,
      (nextVal) => {
        currentVec[idx] = nextVal;
        onVector([...currentVec]);
      },
      step,
    );
    if (readOnlyIndices.has(idx)) {
      input.readOnly = true;
      input.disabled = true;
    }
    row.append(
      h('label', { class: 'vector-cell' }, [
        h('span', { class: 'mono muted', text: slotLabels[idx] ?? `[${idx}]` }),
        input,
      ]),
    );
  });
  return h('div', { class: 'vector-editor-block' }, [
    h('div', { class: 'field-label', style: 'margin-bottom:4px', text: label }),
    row,
  ]);
}

function liveFields(app: StratifyApp, onRefresh: () => void): HTMLElement[] {
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
      '绝不写入 localStorage / IndexedDB / 导出 bundle；刷新即清空。',
    ),
    field(
      '请求模型 (model)',
      h('input', {
        id: 'setup-live-model',
        type: 'text',
        value: app.liveModel,
        onInput: (event) => {
          app.liveModel = (event.target as HTMLInputElement).value.trim();
        },
      }),
      '需在 Worker 的 JEV_ALLOWED_MODELS 白名单内。',
    ),
    field(
      '提示词风格 (promptStyle)',
      selectInput(
        'setup-live-prompt-style',
        [
          ['neutral', 'neutral（中性事实陈述）'],
          ['survival_hint', 'survival_hint（生存压力提示对照）'],
        ],
        app.livePromptStyle,
        (val) => {
          app.livePromptStyle = val as StratifyApp['livePromptStyle'];
        },
      ),
      '进入决策审计元数据，不影响核心结算公式。',
    ),
    field(
      '最大调用上限 (maxCalls)',
      numberInput('setup-live-calls', app.liveMaxCalls, 1, 100_000, (value) => {
        app.liveMaxCalls = value;
        onRefresh();
      }),
    ),
    field(
      '最大输入 Token 预算',
      numberInput('setup-live-tokens', app.liveMaxInputTokens, 1_000, 100_000_000, (value) => {
        app.liveMaxInputTokens = value;
        onRefresh();
      }),
    ),
    field(
      '最长运行分钟 (maxMinutes)',
      numberInput('setup-live-minutes', app.liveMaxMinutes, 1, 240, (value) => {
        app.liveMaxMinutes = value;
      }),
    ),
    ...(exceedsLiveSuggestion(app.draftConfig)
      ? [
          field(
            '超建议规模高危确认',
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
                text: `我确认当前规模超过 ${LIVE_SUGGESTED_LIMITS.maxPopulation} 人 / ${LIVE_SUGGESTED_LIMITS.maxTicks} tick / 间隔 ${LIVE_SUGGESTED_LIMITS.minDecisionInterval} 的建议上限，并承担调用与串行等待成本。`,
              }),
            ]),
          ),
        ]
      : []),
    h('div', { class: 'notice notice-warn', style: 'grid-column: 1 / -1' }, [
      h('strong', { text: 'Live 预算与熔断护栏：' }),
      h('span', {
        text: '所有请求经同源 /api/jev 携带内存 X-Api-Key 转发；遇到 401/403、预算触顶或回退率超限会立即停止实验，绝不静默伪装为离线 mock。',
      }),
    ]),
  ];
}

function scaleWarning(app: StratifyApp, config: RunConfig): HTMLElement {
  const due = Math.ceil(config.schedule.totalTicks / Math.max(config.decision.interval, 1));
  const calls = due * config.population.initialPopulation;
  const estTokens = calls * 520;
  const estLiveMinutes = (calls * 1.1) / 60;
  const large = exceedsLiveSuggestion(config);
  return h('div', { class: `notice ${large ? 'notice-warn' : ''}`.trim() }, [
    h('strong', { text: '调用规模与工时估算：' }),
    h('span', {
      text: `理论上界 ${calls.toLocaleString()} 次个体决策（${due.toLocaleString()} 决策周期 × ${config.population.initialPopulation} 人）。`,
    }),
    h('br'),
    h('span', {
      class: 'muted',
      text:
        app.draftPolicy === 'jev_live'
          ? `预计输入约 ${(estTokens / 1000).toFixed(0)}k tokens · 串行等待约 ${formatNumber(estLiveMinutes, 1)} 分钟。`
          : large
            ? '离线策略已在前端启用零哈希快路径，可流畅运行；若切换 jev_live 需显式勾选超限确认。'
            : '当前规模处于浏览器轻量交互区间。',
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
