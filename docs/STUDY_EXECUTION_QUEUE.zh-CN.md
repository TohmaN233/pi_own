# Study Execution Queue

`StudyExecutionQueue` 是 Study/Research 任务的持久化调度账本。它使用组合根注入的同一个 `DatabaseSync`，不拥有数据库连接、不启动进程，也不把 Windows 隔离器、Pi Agent 或其他执行器导入领域层。

## 受信任的边界与配置

组合根在确认本机隔离能力和安全默认值后，使用带 revision 的 `configureTrustedPolicy` 写入全局并发、CPU、内存和租约策略。未配置策略时，任务可以保留为 `queued`，但不能 admission，因此不会在能力不明时启动执行。

入队必须携带 Host 已注册并在任务中冻结的 `producerContextId`。队列重新读取 Host reservation；缺失、变更或伪造的 context 都会失败。该 provenance 仅保存在内部 job record，任何 `ExecutionQueueJob`、claim 和列表 DTO 都不会泄露它。幂等 replay 同时绑定 project、session 和完整请求指纹；同项目的另一 session 不能接管已有 dispatch key。

`StudyExecutionRequest` 的 `kind` 和 `target` 与 Host 的 `ReserveStudyTaskInput` 一致。未提供 `kind` 的旧调用仍表示 `execution`；调用方可以显式入队 `reading`、`execution`、`validation`、`review` 或 `explanation`。仅 validation/review 可以携带 `target`，并且 target 在 Host reservation 时被冻结为精确版本；这两个 kind 同样需要 trusted producer。所有 queue Study 请求仍要求 producer context，以便 detached coordinator 只接管已冻结的可信来源。Study 请求还会与冻结 admission 的墙钟和内存上限比较。

Research plan 若提供 `sourceReferences`，队列优先按 `(sourceId, contentHash)` 精确核验，所以不同 source 可以有相同内容 hash。旧的 hash-only plan 才要求每一个 hash 唯一对应一个当前 source；无法唯一解析时 fail closed。两种形式都必须与 grant 的 frozen source bindings 及当前 source version 一致。

每个 learning session 或 Research grant 的 quota 在入队事务中 materialize。learning 的 quota key 始终是 project/session，即使任务在 Research phase 中创建；Research grant execution 使用独立 grant key。后续 job 必须带完全相同的 quota，否则入队失败并回滚刚创建的 Host reservation；claim 不会通过“第一个成功的 job”选择 scope quota。

grant-backed Research 的 `queued → admitted` 在同一个 SQLite 事务中调用 Host 的 `assertFrozenResearchAuthorizationCurrent`，并由 Host transition 再次检查。它核验冻结的 plan revision/digest、grant、过期/撤销状态和确切 source version，不使用当前交互式 phase 作授权。learning task 在 Research phase 创建时保存真实 `phase: "research"`，但授权仍是 `kind: "learning"`，不触发 grant 复核；其 queue `mode` 也保留 `research` 供调度记录使用。已经 admitted 的任务不会因 UI phase 切换失效。

## 调度和资源状态

队列状态为 `queued`、`admitted`、`prepared`、`launching`、`running`、`reconciling`、`needs-input` 及终态。每个新 job 获得全局单调 `enqueueOrder`；`claimNext` 按该顺序扫描，而不是按 UUID 偶然顺序。它在一个 `BEGIN IMMEDIATE` 事务内完成：

1. 对 queued grant-backed Research 再核验 frozen authorization。
2. 检查共享的并发、CPU、内存 reservation，以及每个 learning session 或 Research grant 的 runs、累计墙钟和磁盘配额。
3. 写入 reservation，并将 Host 任务从 queued 转为 admitted。
4. 写入具 revision 的协调器 lease。

协调器要在 lease 失效前 heartbeat。失效的 admitted/prepared lease 可以由一个新协调器取得；旧 claim 的写入会被拒绝。`launching` 或 `running` lease 失效后只能转为 `reconciling`，不会回到 queued，因此不可能依据不确定的进程状态再次启动同一个任务。

单个 queued job 的永久 admission 错误（失效的 Research frozen authorization、过期/耗尽 scope quota、Host task 冲突等）会持久化为 `needs-input`，带受限的错误 code/message、协调器 identity 和时间；没有写入 reservation。`claimNext` 继续扫描后面的 job。全局并发/CPU/内存不足是 transient，因此只跳过当前不适配 job；若后面有适配 job 仍可被 claim。`needs-input` 可由用户取消，进而取消仍在 Host queued 的 task。

从 `queued` 取消不会尝试释放从未创建的 reservation；从 `admitted` 取消必须恰好释放一次 reservation，缺少或已释放记录会以 `QUEUE_CORRUPT_STATE` 回滚。`prepared` 取消只记录请求并保持 `prepared`：trusted adapter 用 `acquirePreparedCancellation(jobId, coordinatorId, expectedClaimRevision)` 取得原 private handle 清理准备产物，随后以实际 cleanup usage 调用 `recordTerminalReceipt`。它不能借此启动执行。

`launching`/`reconciling` 的 failed 或 cancelled receipt，以及 prepared cancellation 的 cleanup receipt，可以直接进入对应 Host 终态，queue 不会伪造 `running` 事件。成功和 `limit-reached` receipt 必须先经 `confirmRunning(jobId, coordinatorId, expectedClaimRevision, executionEvidence)` 记录正向 runner evidence。

receipt 始终报告并累计实际墙钟和磁盘用量，且在 Host terminal event 中记录 `exceeded` 项。已确认 `running` 的 job 若超过单 job reservation 或 scope quota，终态强制为 `limit-reached`。从未启动的 cleanup/launch-failure 若请求 `failed` 或 `cancelled`，即使其用量超额也保留真实 terminal status；仍会收费、写 exceeded 审计信息、释放 reservation，并清空 terminal job 的 claim owner 与 lease。直接取消 admitted job 同样清空 lease 并释放 reservation。

## Prepared handle 的两阶段接线

队列不认识任何 runner 私有字段。可信适配器在**尚未启动执行器**的 prepare 阶段生成下列封装，并立刻调用 `persistPreparedHandle`：

```ts
type PreparedExecutionHandle = {
  kind: string;
  version: number;
  privateHandle: Record<string, unknown>;
  publicSummary: Record<string, unknown>;
};
```

`privateHandle` 仅保存于私有表，只由已 claim 的 `beginPreparedLaunch`、`acquirePreparedCancellation` 或 `acquireReconciliation` 返回给协调器。`ExecutionQueueJob` 仅公开 `{ kind, version, publicSummary }`；队列拒绝 summary 中 token、secret、password、credential、authorization、cookie 或 private 字段。适配器仍须确保其余 summary 值不包含敏感数据。

handle 的根对象、`privateHandle` 和 `publicSummary` 都必须是有限、无循环、最大 32 层、可精确 JSON round-trip 的 plain JSON：只允许 primitive、array 与 `Object.prototype` plain object，拒绝 `Date`、`Map`、class instance、accessor、symbol、非 enumerable property、`undefined` 和非有限 number。

例如 Windows 隔离适配器可用 `kind: "windows-isolated-run"` 包装 run directory、控制目录和 cancel token；Pi 上下文应使用不同 kind。队列不假定这些字段、也不验证某个语言已可执行。持久化成功后，协调器调用 `beginPreparedLaunch`，再调用其具体执行器的 launch；后者的 receipt 再通过 `confirmRunning` 与 `recordTerminalReceipt` 记录。相同 handle 的不确定 launch 走 reconciliation，不能重新 launch。

## 验证

运行：

```powershell
node --test scripts/study-execution-queue.test.mjs
```

覆盖跨 SQLite connection 的共享容量、按入队顺序扫描、永久/临时 admission 隔离、幂等 session binding 与外层回滚、过期 claim、含糊 launch reconciliation、prepared cancellation cleanup、缺失/重复 reservation 的回滚、scope quota materialization、单 job/累计用量、generic task kind/target、Research 中 learning 的真实 phase、显式 source identity、phase 切换、正向运行 evidence、未启动 cleanup/launch failure 的超额审计与 lease 清理、过期/撤销 grant 与 source revision 的 queued admission 拒绝，以及 handle JSON/redaction 边界。
