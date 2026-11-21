# 0041：P6-01 Stage B 第二、三个确认轮结果与证据链收口

- 日期：2026-11-05
- 作者：Runner/实验负责人（文档收口，自主授权）
- 关联：P6-01（01 §9）、07 §3/§8、changes/0037–0040、`9890337` / `f7d0fcd`
- 性质：**补登已提交的两个确认轮结果 + 文档与证据链一致性修正**；不新增实验、不改预注册设计、不改判读结果

## 1. 补登结果（两个提交此前只有 research 报告，未进变更记录）

| cell              | 判定                               | 关键事实                                                                                                                                                                       |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env0=compressed` | **确认通过**（07 §8 全条件）       | 60/60 run、0 失败/灭绝/回退；w2b ΔG −0.0433，CI [−0.0549, −0.0196] 不跨 0、方向一致率 1.00、100% 超 baseline 波动带；与 `env0=expanded` 呈镜像，env0 双向确认完成              |
| `crossDays=half`  | **未确认**（预注册口径的正常出口） | 60/60 run 全成功，但 TV 0.0043、ΔG −0.0105、ΔMup +0.0059 全部未达门槛，CI 跨 0、0% 配对超波动带；Stage A 200 人 × 730 tick 的 ΔMup +0.114 在 1000 人 × 3650 tick 衰减到 +0.006 |

两份结果报告见 `docs/research/2026-11-05-p6-01-stage-b-{env0-compressed,crossDays-half}.md`；
机器可读判读为 `out/p6-stageB-analysis-*.json`（`confirmed=true/false`）。
**Stage B 是效应确认层，不构成结构结论、校准或 P6-05 验收（AGENTS #9）**；G6 仍未通过。

## 2. 预注册标识不一致（待裁决，不静默改写）

`changes/0039` §2 的 v2 冻结清单与 `docs/reference/artifacts.md` 旧条目把该单元记为
`p6-stageB-crossDays-half-c1206246`（prereg `sha256:c1206246…`），但仓库内实际产物
`out/p6-stageB-prereg-crossDays-half.json`、`out/p6-stageB-analysis-crossDays-half.json`
一致使用 **`p6-stageB-crossDays-half-83a1d58a` / `sha256:83a1d58a…`**（budgets 同为
D-04 v2：60 run / 480 min / 512 MB，确认种子集 `p6-stageB-seed-001…030` 未变）。

- 本次收口把**文档引用统一为实际产物标识**，并把 `changes/0039` 的表格保留为历史记录
  （变更记录只追加，不回改）；
- 两处标识为何不同、是否属于按 07 §3 应登记的重冻结，**尚无证据判定**，登记为待裁决项，
  由实验负责人核对冻结脚本输出后再决定是否补充 ADR/预注册说明；
- 在裁决前不重跑、不回填门槛、不换窗口或种子；该单元结论仍按已入库产物的
  `confirmed=false` 记录。

## 3. 队列实况（截至本次收口，实验进度暂停）

| cell                                | 状态                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `env0=expanded` / `env0=compressed` | 已确认通过（changes/0040、本条）                                                                                           |
| `crossDays=half`                    | 已判读未确认（本条）                                                                                                       |
| `crossDays=double`                  | `out/p6-stageB-ledger-crossDays-double.json` 仅 30/60 条且全为 baseline，0 失败，无 summary/analysis；可用 `--resume` 续跑 |
| `psi=1` / `needThreshold=0.9`       | manifest 已按 v2 冻结，未开跑                                                                                              |

其余 3 个未入库的 v2 预注册 manifest（`crossDays-double` / `psi-1` / `needThreshold-0-9`）
本次随收口纳入版本控制，使 6 个冻结单元均可离线复算；`.gitignore` 白名单与
`docs/reference/artifacts.md` 同步登记 sha256。

## 4. 文档状态同步

- `README.md` / `docs/README.md` 状态栏、`docs/01` §9/§12、`docs/12` 交接 rev 21：
  由「P3–P7 未开工、P6 未开始、P5a CLI 缺、P2 冒烟待密钥」更正为 P0/P1/P1.5(2 类)/P2 7/7/P5a 5/5 已完成、
  P6-01 Stage B 3/6 已判读、P3/P4/P5b/P7 未开工；
- D-04 预算由 v1（Stage B 240 min）补记 v2 重冻结（480 min，changes/0039）；
- `docs/research/README.md` 索引补两份 Stage B 报告；`artifacts.md` 补齐文件体积与 sha256；
- 修复质量门禁两处红灯：`pnpm format`（三份 Markdown 表格/排版）与 `pnpm lint`
  （`test/unit/runner/run-progress-live.test.ts:21` 未使用的 `signal` 参数；删除该形参并同步
  调整同文件 `:130` 调用，不改变取消语义与测试断言）。

## 5. 影响与验证

- 不改变 `rulesVersion` / `engineVersion` / 参数注册表 / golden / 任何实验产物；
  不新增或替换 run，不影响既有基线的可比性；
- 验证：`pnpm format` / `lint` / `typecheck` / `typecheck:core` / `check:docs` / `test` /
  `test:integration` / `test:e2e` / `build` 全绿（660 单测、4 集成、110 个 Markdown / 211 条链接）；
- `pnpm test:coverage` 实测覆盖率 98.31% statements / 95.18% branches 达标，但本机沙箱的
  批量删除保护会拦截 `coverage/.tmp` 清理步骤使命令 exit=1，属环境限制而非项目测试失败；
  不把该命令计入本次「门禁通过」清单。
- 未完成：Stage B 剩余 3 单元（含 `crossDays=double` 续跑）、P6-01 收口记录、P6-02～P6-05、
  G6 三类结构正式验收；Jev 网关旧 Key 轮换与 Cloudflare 账号仍为外部依赖。
