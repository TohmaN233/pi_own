# Research 阶段的有界学习准入

`StudyResearchHost.reserveStudyTask` 代表有界学习任务。它可以在 `study` 或
`research` 交互阶段创建，但创建时仍以调用方提供的 phase revision 进行 CAS；Host
不会为了创建学习任务而切换当前阶段。`kind` 是通用 `TaskKind`：阅读、执行、验证、
复核和解释均保留为 learning authorization；省略 `kind` 的 queue 旧调用默认是
`execution`。

直接调用 Host 时，阅读和解释任务不需要 runner 上下文。执行任务必须带有由
`registerTrustedRunnerContext` 创建并持久化、属于同一项目和会话的
`producerContextId`；验证和复核也需要该 context，并且只能携带 reservation-time
冻结的 `target`。其他 kind 不能提供 target。这个要求在两个交互阶段完全相同。
`StudyExecutionQueue.enqueueStudy` 则要求每个 queue request 提供 producer context，
以便 detached coordinator 只能处理已有可信 provenance 的任务。

冻结授权由 `kind` 区分：

- `kind: "learning"` 是学习任务，保存其实际创建时的 `phase`、`phaseRevision`
  和受限的 `admission`；Research 阶段创建的学习任务仍不是 grant。
- `kind: "research-grant"` 是已批准研究计划产生的任务，保存 grant、计划版本和
  语义摘要；只有这类任务可以通过 `recordResultFromFrozenTask` 记录
  `ResearchResult`。

通过 `StudyExecutionQueue.enqueueStudy` 排队的 learning task 会将其实际冻结 phase
写入 job `mode`。所以在 Research 创建的 reading、execution、validation、review 或
explanation task 会显示 `mode: "research"`，同时仍保持 `authorization.kind:
"learning"`；它使用 project/session learning quota，不需要也不消费 research grant。

旧存储记录没有 `kind` 时，Host 仅接受完整且互斥的旧 Study 形状或旧 Research
形状，并在读取时标准化。缺字段或同时混入 learning admission 与 grant 字段的记录
以 `CORRUPT_STATE` 拒绝，不能猜测其授权含义。

队列协调器使用 `readTaskForCoordinator(taskId)`。该读取会校验持久化 payload 的
哈希、任务与冻结授权的项目一致性以及当前项目成员关系，但不读取当前交互 phase。
因此任务在用户切换学习/研究界面后仍可继续被协调器准入；失去成员资格或损坏的存储
记录会明确失败。

grant-backed Research 入队时会优先以 plan 的 `sourceReferences` 精确匹配 source ID
和内容 hash；只有旧 hash-only plan 必须将每个 hash 唯一解析为当前 source。这不会
把具有相同内容 hash 的两个明确 source 误判为含糊依赖。
