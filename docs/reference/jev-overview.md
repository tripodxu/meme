# Jev（TypeSafe）简介与使用说明

> 本文是参考资料，不是施工契约。Jev 的接口、模型名、价格与限流在接线和发布前必须复核官方文档（<https://docs.typesafe.ai/introduction/quickstart>、<https://docs.typesafe.ai/models>）。决策协议以 [04-jev-decision-contract.md](../04-jev-decision-contract.md) 为准。

## 1. 定位

Jev 是 TypeSafe 推出的 AI 判断模型，定位并非聊天或内容生成，而是一个专为程序化决策设计的 "System One" 模型：只做判断，不生成文本。

Jev 根据提供的“状态（State）”和“问题（Questions）”，返回代码可直接读取的结构化答案（如概率、选项、分数），而不是一段供人阅读的文字。设计目标是替代流程中需要“读懂意思并做出判断”的环节，让代码掌控流程。

## 2. 三种核心判断原语（问题类型）

使用时需要将问题声明为以下三种类型之一：

- **Noul（是非判断）**：进行二分类判断，输出一个 0 到 1 之间的概率值，代表“为真”的可能性。例如：判断一条客服消息是否紧急，返回 `0.95` 表示非常紧急。
- **Choice（多选判定）**：从最多 255 个自定义选项中选出最优的一个，并附带置信度。适合 UI 自动化选择元素、判断业务分支等场景。
- **Score（分级打分）**：在 2 到 10 档的范围内进行评分，用于评估风险等级、缺陷严重程度等有强弱差异的场景。

> Stratify MVP 只使用 `Choice`，且每个到期个体一次请求；`Noul`/`Score` 不进入结算。

## 3. 使用流程概览

1. **获取 API Key**：访问 TypeSafe 控制台（console.typesafe.ai）创建密钥。需要注意，目前申请 Key 需要先绑定支付方式并支付 25 美元的费用。
2. **配置环境变量**：将密钥设置为 `TYPESAFE_API_KEY`，后续 API 调用和 SDK 会自动读取。
3. **在 Playground 中试用（推荐）**：写代码前，可以在官方 Playground 手动输入 State 和 Questions，直观感受三种问题类型的返回结果。
4. **通过 API 调用**：使用 HTTP 请求调用 `https://api.typesafe.ai/v1/systemone`，在请求体中按格式传入 State 和 Questions。

Stratify 的浏览器端通过同源 `POST /api/jev` 代理，密钥只驻留页面内存（`X-Api-Key`），不落库、不写日志、不进 URL。

## 4. 关键参数与限制

| 项 | 值 |
|---|---|
| 当前版本（基线） | `jev-1.13.0` |
| 上下文限制 | 单次请求最多 64K Token，其中 State 与最长问题合计不超过 32K Token |
| 输入模态 | 仅文本，不支持图片、音频或视频 |
| 计费 | 输出免费，仅按输入 Token 计费，价格远低于通用大模型 |
| 速率限制 | 每秒 250,000 Token 或每分钟 1,200 次请求 |

## 5. 已知局限

官方文档指出，Jev 在计数、日期比较、非英语语言的准确率上可能偏低，且明确不适用于“生成”任务。

因此 Stratify 的硬性边界是：财富、胜率、成本、阶级、寿命、网络和宏观指标全部由确定性核心计算，Jev 只从代码枚举的合法行动中选择。

## 6. 与本项目文档的关系

- 决策协议、回退、重试与预算：[04-jev-decision-contract.md](../04-jev-decision-contract.md)
- 安全与成本约束：[11-security-cost-constraints.md](../11-security-cost-constraints.md)
- 实验中的模型对照与重测信度：[07-experiment-calibration.md](../07-experiment-calibration.md)
