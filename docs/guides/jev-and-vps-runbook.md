# Jev 接入与 VPS 实操手册（交接用）

> **文档定位**：派生运行手册，记录**实测事实 + 可复制命令 + 踩坑**，不构成新的验收口径。
> 协议语义以 [04 Jev 决策协议](../04-jev-decision-contract.md) 为准，VPS 部署以
> [09 部署与运维](../09-deployment-operations.md) 为准，两者冲突时以编号文档为准。
>
> **最后核对**：2026-11-04 23:10（本地与 `2zhou` 均实机复核）。
> **适用提交**：`0f4656c` 及之后。

## 1. 一句话结论

官方域名 `api.typesafe.ai` 在开发机返回 **451**、在 VPS 上网络可达但该 Key 返回 **401**；
**本项目可用的 Key 只对自建网关 `https://jev.logicc.top` 有效**。VPS `2zhou` 已验证可直接跑
mock 与 live 冒烟，且 `finalStateHash` 与本地逐字相同。

## 2. Jev 接入事实

### 2.1 端点

| 端点                                   | 开发机（本地） | VPS `2zhou`    | 结论                            |
| -------------------------------------- | -------------- | -------------- | ------------------------------- |
| `https://api.typesafe.ai/v1/systemone` | `451` 地域限制 | `401` 鉴权失败 | **不可用**（网络与 Key 都不通） |
| `https://jev.logicc.top/v1/systemone`  | `200`          | `200`          | **生产路径**                    |

`451` 的响应体是 `Typesafe is not available in your region`；换到美国出口只能解决网络，
解决不了该 Key 在官方端点的鉴权。**不要再尝试直连官方域名**，除非换一把官方签发的 Key。

### 2.2 代码中的位置

| 项               | 位置                                                     | 默认值                                 |
| ---------------- | -------------------------------------------------------- | -------------------------------------- |
| 默认端点常量     | `src/decision/jev-client.ts` `DEFAULT_UPSTREAM_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` |
| 端点配置项       | `JevClientOptions.endpoint`（可选）                      | 未设置时回落默认值                     |
| 端点校验         | `resolveEndpoint()`                                      | 只接受 `https`，禁止内嵌用户名/密码    |
| token 估算器版本 | `TOKEN_ESTIMATOR_VERSION`                                | `utf8-three-quarter-v1`                |
| 冒烟脚本         | `scripts/smoke-live.mjs`                                 | 密钥只从 `JEV_API_KEY` 读              |

端点校验发生在**预算预留与首次 attempt 之前**，因此非法端点不会消耗预算或发出请求。

### 2.3 密钥处理（硬性要求）

- 只从环境变量 `JEV_API_KEY` 读取；**禁止**写入仓库、fixture、日志、URL、命令行参数。
  上传到 VPS 时用 `ssh` 的 stdin 传，见 §4.3。
- **本文档不记录密钥**。上一轮联调使用的 `jv-…` 已出现在对话记录中，应按已泄露处理，
  **接手后的第一件事是到密钥页轮换**，旧 Key 立即吊销。
- 日志脱敏已实现：决策记录只落 `requestedModel`、真实 `model`、`usage`、`fallbackReason`，
  不落 Authorization 头。

### 2.4 模型名与计费

- 网关会把请求模型名归一化：请求 `jev-1.13.0`，响应 `model` 为 **`jev-1.13-free`**。
  判断真实模型要看**响应体**，不要看请求参数。
- `/v1/models` 返回的可用模型只有 `jev-1.13-free`。
- 响应 `usage.cost = 0`、`billing_source = "free"`。**这是当前免费档的事实，不代表生产免费**，
  也不构成 `11 安全与成本约束` 的预算依据。

### 2.5 请求体形状

`POST /v1/systemone`，`Authorization: Bearer <key>`：

```json
{
  "state": {
    "schema": "stratify-decision-v1",
    "tick": 120,
    "self": {},
    "society": {},
    "targets": []
  },
  "model": "jev-1.13.0",
  "questions": {
    "action": {
      "type": "choice",
      "instructions": "...",
      "criteria": { "accumulate": "...", "ascend": "...", "compete:a-0008": "..." }
    }
  }
}
```

实际构造在 `buildRequestBody()`；`state` 由 `buildDecisionState()` 序列化，形状受
`schema/decision-state.prompt-v3.json` 约束。**不要手工拼请求体**，否则会与 promptVersion 脱节。

### 2.6 两个曾经踩过的坑

1. **Cloudflare `403 error code: 1010`**：`python-urllib` 的 UA/签名被拦截。`curl` 与 Node
   `fetch`（undici）均正常。排查时不要用 Python 探活，会误判成「网关卡不可用」。
2. **估算器低估导致 live run 自锁**（真 bug，已修）：旧 `utf8-half-v1`（`bytes/2`）对真实请求
   估 1085、上游实际 1200。`AttemptBudget` 一旦 `overageDetected` 即**永久** `exhausted`，
   于是第一个成功调用之后，第二个决策起全部 `budget_exhausted` 且 `attempts=0`——
   **与 `maxInputTokens` 设多大完全无关**。现为 `utf8-three-quarter-v1`（`bytes×3/4`），
   对两条真实样本余量 26–35%。

> 改估算比例前必读：`test/unit/decision/real-response-fixture.test.ts` 有反向断言，
> 要求估算值 **≥** 上游实测 token，并断言旧口径会低估。把比例调回 `bytes/2` 会直接失败。

## 3. 冒烟命令

```bash
pnpm build

# 1) 只校验配置与端点格式，不发请求
node scripts/smoke-live.mjs --dry-run

# 2) 真实调用（规模与视野都很小，仅验证链路）
JEV_API_KEY=... JEV_ENDPOINT=https://jev.logicc.top/v1/systemone \
  node scripts/smoke-live.mjs --population 8 --ticks 30 --max-input-tokens 300000
```

常用参数：`--population`（默认 8，需 ≥2）、`--ticks`（默认 10）、`--max-calls`、
`--max-input-tokens`（默认 200000）、`--model`、`--prompt-style neutral|survival_hint`、
`--seed`、`--out <path>`、`--dry-run`。

输出是 JSON 摘要：成功率、回退原因分布、`usage`、延迟 p50/max、真实 model、`passed`，并显式带
`isExperimentalEvidence: false`。

**参考基线**（2026-11-04，`out/p2-07-smoke.json`）：8 人 / 30 tick / 4 决策点 = 24 决策，
**24 成功、0 回退**，input 39753 / output 2981 tokens，`listCost=0`，p50 1.30 s / max 4.41 s。

## 4. VPS `2zhou`

### 4.1 连接与规格

```bash
ssh 2zhou        # 别名定义在 ~/.ssh/config：HostName ssh.instabox.sh，Port 2222
```

用户名与私钥在 `~/.ssh/config` 中，**不在此复写**。若公司/个人环境无此别名，需自行补配置。

| 项      | 实测值                                            |
| ------- | ------------------------------------------------- |
| 规格    | 4 核 / 7964 MB 内存 / 根分区 11 GiB 可用          |
| Node    | v22.23.3（满足 >=22.18）                          |
| git     | 2.47.3                                            |
| 出口 IP | `207.188.6.69`（美国，故官方端点非 451 而是 401） |

### 4.2 在 VPS 上跑冒烟（不克隆整仓）

`dist/` 只有一个纯 JS 依赖 `@noble/hashes`，因此只需推 `dist` + 脚本 + 该依赖：

```bash
# 本地
tar czhf /tmp/meme-smoke.tgz dist scripts/smoke-live.mjs node_modules/@noble

# VPS
cat /tmp/meme-smoke.tgz | ssh 2zhou '
  rm -rf ~/meme-smoke && mkdir -p ~/meme-smoke &&
  tar xzf - -C ~/meme-smoke && echo EXTRACTED'
```

**必须带 `-h`**：pnpm 的 `node_modules/@noble/hashes` 是符号链接，`tar -cz` 打出的是断链，
VPS 上会以 `ERR_MODULE_NOT_FOUND` 失败。

### 4.3 密钥经 stdin 传入

```bash
printf '%s' "$JEV_API_KEY" | ssh 2zhou '
  read -r K; cd ~/meme-smoke &&
  JEV_API_KEY="$K" JEV_ENDPOINT=https://jev.logicc.top/v1/systemone \
  node scripts/smoke-live.mjs --population 6 --ticks 1 --max-input-tokens 200000'
```

`read -r K` 从 stdin 取，密钥不进 `ps` 输出、不进 shell 历史、不落盘。

### 4.4 确定性复核

同一场景（6 人 / 1 tick）在本地与 VPS 上 `finalStateHash` **逐字相同**，
说明跨机器确定性成立。做 P6 前建议每次换环境都重跑这条对照，比只看「跑通了」更有价值。

### 4.5 用完清理

```bash
ssh 2zhou 'rm -rf ~/meme-smoke /tmp/jev_* ; df -h / | tail -1'
rm -f /tmp/meme-smoke.tgz
```

磁盘只有 11 GiB，`out/` 全量产物（约 10 MiB 已入库版）以外的调试文件不要留在上面。

## 5. 故障速查

| 现象                                           | 根因                                      | 处理                                                |
| ---------------------------------------------- | ----------------------------------------- | --------------------------------------------------- |
| `451 Typesafe is not available in your region` | 官方端点地域封锁                          | 改用网关端点                                        |
| `401 authentication_error`（VPS 上）           | Key 非官方签发                            | 改用网关端点；或换官方 Key                          |
| `403 error code: 1010`                         | Cloudflare 拦 `python-urllib`             | 用 `curl` 或 Node `fetch` 排查                      |
| `budget_exhausted` 且 `attempts=0`             | overage 触发后预算永久锁死                | 检查估算器是否仍为 `utf8-three-quarter-v1`；看 §2.6 |
| `ERR_MODULE_NOT_FOUND: @noble/hashes`          | `tar` 未跟随软链                          | `tar czhf`                                          |
| 第二个决策起全部回退                           | 同上 overage；或回退率熔断（1/2=50%>20%） | 先看 `fallbackReason`，不要盲目加预算               |
| 模型名与预期不符                               | 网关归一化                                | 以响应体 `model` 为准                               |

## 6. 边界：这些事**还没有**被验证

- 冒烟规模（8 人 / 30 tick）远低于 `07 §8` 的验收口径（≥30 配对种子、40/200/1000 人、
  730/3650 tick），**不是 P6 证据，也不是参数校准**。
- 没有验证并发调用、全局限流与共享预算（P5-02 未实现，目前只有单 run 级 `AttemptBudget`）。
- 没有长时 soak、没有 1000 人 live 运行、没有跨地域延迟对照。
- P4-08 的 Worker 同源代理未实现，浏览器侧 live 路径尚不存在。
- 网关是个人自建服务，**可用性、模型版本与免费档策略都不由本项目控制**；任何依赖它的
  验收结论都必须在报告中注明「经自建网关，非官方端点」。

## 7. 接手第一步

1. **轮换 Jev Key**（旧的已泄露），新 Key 只放本地环境变量。
2. `git push origin main`——本地有 2 个未推送提交（含估算器 bug 修复）。
3. 按 `docs/01` 的依赖顺序推进 **P5-01 批跑 CLI**（当前唯一阻挡 P6 的工程件）。
