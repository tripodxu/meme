# P1.5-02 均值场 / 不动点分析（rules-v3 → rules-v4）

> 状态：P1.5 预研产物；数值检验见 `src/runner/mean-field.ts` 与 P1.5 运行报告。
> 本文不构成校准结论；结构判异以 07 §8.1 预注册聚类协议为准。

## 1. E–P 环路（rule.md 33/34/35）

每 tick 更新：

```text
Congestion[c] = clamp((P0[c]/max(P[c], floor))^η, cMin, cMax)
Polarization[c] = clamp(exp(κ·z[c]·(G−Gref)), pMin, pMax)
E[t+1,c] = (1−ρE)·E[t,c] + ρE·env0[c]·Congestion·Polarization
```

**符号**：∂Congestion/∂P[c] < 0（η>0）——阶级拥挤压低自身机会，是负反馈；
∂Polarization/∂G 同号于 z[c]——G>Gref 时高层机会相对增加（正反馈，规则声明其不承担制动）。

**不动点**：若 P 收敛到稳态 P*，则长期 E* = env0[c]·Congestion(P*[c])·Polarization(G*)。
当 P*=P0 时 Congestion=1，E*=env0[c]·Polarization(G*)。

**P0[c]=0 的阶级**（03 §6 阶段 H）：Congestion 落到 cMin=0.20——无入口激励，
该阶级不会自发获得机会优势；若人口升入后 P[c]>0，Congestion 立即按公式计算。
此语义（v3 无入口激励）在可达性矩阵中单独评估（P1.5-03）。

## 2. O–Mup–S–G 环路（rule.md 42/43/44）

```text
Otarget = σ(θ0 + θM(Mup−Mref) − θG(G−Gref) − θS(S−Sref))
O ← O + (Otarget−O)(1−e^(−Δt/τO))
cost = crossBase × (1−discount) × clamp(exp(λO(0.5−O)), mMin, mMax)
rewire 权重 = exp(−H(1−O)|Δclass| − hV|Δln V|)
```

**解析偏导**（σ 的局部斜率 = Otarget(1−Otarget)）：

| 关系          | 符号                  | 机制                     |
| ------------- | --------------------- | ------------------------ |
| ∂Otarget/∂Mup | +                     | 流动参与率越高社会越开放 |
| ∂Otarget/∂G   | −                     | 贫富差距压低开放度       |
| ∂Otarget/∂S   | −                     | 隔离度越高开放度越低     |
| ∂cost/∂O      | −（经 λO 乘子）       | 开放使跨越更便宜         |
| ∂Mup/∂cost    | −                     | 越便宜越多上升           |
| ∂S/∂O         | −（经重构权重 (1−O)） | 开放使跨层连边更易形成   |

**两条正反馈路径**（rule.md 45）：

1. O↑ → cost↓ → Mup↑ → Otarget↑；
2. O↑ → 跨层边↑ → S↓ → Otarget↑（S<Sref 时 −θS(S−Sref) 项为正）。

**制动**：阶级拥挤（Congestion）、持有成本 ψ、竞争损耗、寿命。环路的定量增益
（θM×斜率、λO×crossBase 等）由 `oTargetGradients()` 数值给出；
在默认参数（θM=8、θG=6、θS=4、λO=2）下，斜率在 Otarget=0.5 处最大（0.25）。

## 3. 顶层可持续性与“旋转门”吸收子（rule.md 5/7/37）

顶层（c=C−1）的持有/收益比：

```text
需求增速 = ψ[C−1] × B × E[C−1]        （baselineSum 每 tick += B×E）
收益增速 = B × E[C−1] × ge × F(hard) × Opportunity
```

个体在顶层可持续 ⇔ ge×F(hard)×Opportunity ≥ ψ[C−1]。
默认 ψ[4]=3.5、截断对数正态 ge∈[0.2,3]、F(hard)∈[0,1]、Opportunity∈[0.7,1.5]：
中位数个体（ge≈1, F≈1）的收益/需求比 ≈ 1/3.5 ≈ 0.29 < 1 ⇒ **中位数个体在顶层必然入不敷出**，
Value 相对需求线下降 → belowNeedStreak 累积 → 被动跌落 → 重新上升。
预测：顶层人口由“升-耗-落”循环维持（旋转门），`Mup` 长期偏高，
顶层占比存在一个 <1 的稳态，由 cycle 时间尺度与跌落阈值决定，而非永久吸收。

**顶层永久吸收需要** ψ[C−1] < median(ge×F×Opp)，即持有成本低于中位生产力——
这构成参数空间中“顶层塌缩”区与“旋转门”区的分界线（预注册网格的
`needMultiplier=flat`、`ψ=1` 消融正是对该分界的检验：ψ=1 ⇒ margin≈1/1 ≥ 1 ⇒ 预期顶层占比显著升高）。

## 4. 可检验预测清单（与 P1.5 运行对照）

1. 对每个初始占比为正、仿真占比偏离 P0 的阶级，Congestion 符号与公式一致
   （`checkCongestionSigns`，预期全部成立——这是实现一致性而非涌现）。
2. 旋转门区：baseline（margin≈0.29）的 Mup 显著高于 0、P[4] 稳态 <1；
   ψ=1 消融的 P[4] 显著高于 baseline（D 或 TV(P) 达到 07 §8 实际差异门槛）。
3. O 反馈：ablation:O=fixed 的 O 恒等于 0.5，dynamic 单元的 O 随 Mup/G/S 移动；
   dynamic 与 fixed 的 S/cost 结构差异方向与 §2 符号表一致。
4. 不动点存在性：至少一组 (P*, G*, O*) 使 E 更新与占比更新的联合映射不动
   （数值上以 w3 窗口均值的块间漂移 < 预注册阈值近似验证，见 07 §5 平稳性诊断）。

## 5. rules-v4 的均值场修正（changes/0004）

v3 的简并根源：需求与收益同源（都正比 `B×E[c]`），可持续性比 `ge·F·Opp/ψ[c]` 与 E 无关。

v4 修正后的可持续性比：

```text
ratio[c] = ge·F(hard)·Opportunity / (ψ[c] × (E[c]/E[0])^φ)
```

默认 φ=1、env0=[1,1.5,2.2,3.2,4.5]、ψ=[1,1.3,1.8,2.5,3.5]、中位数 ge·F·Opp≈1.2：

| 阶级 | ψ[c]×(E[c]/E[0])^φ | ratio[c]          |
| ---- | ------------------ | ----------------- |
| c0   | 1.0                | 1.20（可持续）    |
| c1   | 1.95               | 0.62（边缘）      |
| c2   | 3.96               | 0.30              |
| c3   | 10.2               | 0.12              |
| c4   | 15.75              | 0.076（快速流失） |

**预测**：φ=1 时底层可持续、顶层快速流失 → 稳态偏向金字塔；
φ 越小越接近 v3 的旋转门；φ 是结构类别的连续旋钮（网格扫描 {0, 0.5, 1, 1.5}）。
Congestion 反馈仍在：阶级被抽空 → P[c]<P0[c] → E[c]↑ → ratio 进一步下降
（该阶级更难停留），但同时 income 上升使经停时间变长——净效应由仿真判定。

θM 8→3 的预测：Mup 项不再把 O 钉在 1，O 可进入中间区间（封闭分层 O≤0.25 与
高流动 O≥0.6 的标签条件变为可达），具体位置取决于稳态 Mup/G/S。
