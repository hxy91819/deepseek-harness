# Agent Note：并发 ACP 提示词按轮次中 steering 准入

Status: implemented

[English](2026-09-18-acp-mid-turn-steering.md) | 中文

## 问题

每个 `AcpSession` 模块只保留一个进行中提示词，轮次运行期间第二个 `session/prompt` 会被 `invalidParams` 拒绝。底层 `Agent` 已提供 `agent.steer(message)`——由正在运行的轮次在最近步骤边界认领的 next-step 输入，driver 空闲时则开启新轮次。注入轮次中 steering（在第一个提示词运行时发送第二个提示词）的 ACP 自动化客户端被拒绝了一个 runtime 本身支持的能力，而 `initialize` 响应中也没有任何信号能把这种拒绝与缺失特性区分开。

## 决策

`AcpSession` 用 `Set<InflightPrompt>` 跟踪进行中提示词；消息 id 在准入期间异步分配，因此关联依赖每个条目的 `messageId` 字段在入队发布后取值，而不是以 id 为键的映射。一组中的第一个提示词发送 `agent.followup`；在另一个提示词进行中到达的提示词发送 `agent.steer`，因此它在最近的步骤边界被认领——及时到达则并入正在运行的轮次，否则开启新轮次——而不是排在整组轮次之后。

关联仍依赖 `agent/inbox/claimed`：事件中的消息 id 把认领轮次号落到匹配条目上，无论该条目走的是哪条准入路径；`agent/inbox/discarded` 在消息于任何认领前被移除时把该条目按 `cancelled` 结算。被 steering 的提示词与开启其认领轮次的提示词以完全相同的方式结算——非错误 `turn/end` 记录其 stop reason，整个 Agent 空闲加上已 drain 的更新尾部触发结算；错误结尾使其拒绝；`session/cancel` 或 teardown 把每个条目按 `cancelled` 结算。[followup enqueue 与 owned runs](../architecture/2026-07-30-followup-enqueue-and-owned-runs.zh.md) 中记录的区间语义不变：提示词报告的是准入它的活动的结局，而不是因果归因。

`initialize` 公布 `_meta.midTurnSteering: true`，即客户端用来发现基于提示词的轮次中 steering 的 ACP `_meta` 通道。

## 已考虑的替代方案

**继续拒绝并发提示词。** 否决：runtime 本身已支持该注入，拒绝只是把代价转嫁给客户端——先取消再重新提示，并丢失正在运行轮次的状态。

**把第二个提示词排为下一轮 follow-up。** 否决：把注入静默推迟到整组轮次之后，改变了 steering 客户端请求的语义，也把指令推迟到无法再影响正在运行轮次下一步的位置。

**让每个提示词在各自的 turn/end 结算，而不是整个 Agent idle。** 否决：轮次结束不等于会话停止——steering 认领可能延长正在收尾的轮次，且兄弟活动可能仍在继续——过早结算会在自有工作仍在运行时报告 `end_turn`。

## 后果

并发的 `session/prompt` 调用共享该会话的轮次生命周期，各自按认领它的轮次结局结算。`session/cancel` 与 teardown 结算的是一组 waiter，而不是单个槽位。单提示词限制的错误已不存在；其余的提示词拒绝只包括准入前校验、已退役 agent 和 disposal。`_meta` 标记是附加协议元数据——从不检查它的客户端只会观察到原本会被拒绝的调用现在成功了。

## 验证

turns 测试套件在一个带闸门的工具调用处保持轮次开启，展示第二个提示词在同一轮次内到达模型——一个 `turn/start`，steering 文本出现在随后的请求中——并展示 `session/cancel` 下所有进行中提示词按 `cancelled` 结算。multi-session 套件覆盖各会话独立 steering；disposal 套件覆盖 teardown 对多个 waiter 的结算；bridge 套件固定 `initialize` 中的 `_meta.midTurnSteering`。无密钥的 `steer-mid-turn` 快照场景通过快照 harness 的 `promptAndSteer` 操作驱动组装后的 ACP 服务器，固定 `next-step` inbox 插入、同轮次认领和两个 `end_turn` 结果。
