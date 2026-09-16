# Study Agent Queue

`StudyAgentQueue` 是 `StudyResearchHost` 任务状态机前的持久化 Pi Agent 调度层。它服务于阅读、独立复核和解释任务；它不直接调用模型或任何付费提供商。浏览器只能读取没有本地 JSONL 路径和 producer handle 的任务投影，受信任 worker 才能通过有效租约读取 `sessionFile`。

## 入队和重放

`enqueueLearning(input, bindPacket)` 在一个 SQLite savepoint 中依次完成：

1. 校验项目成员、冻结 source/hash/locator 证据和任务输入；阅读任务严格绑定 1–8 个块。
2. 以真实 Pi session identity `pi-session:<agentSessionId>` 注册受信任 producer context。
3. 用该 context 保留 Host 任务，取得真实 `taskId`。
4. 调用同步、幂等的 `bindPacket(taskId)`，保存其 task-id-bound `packetHash`。
5. 保存不可变 evidence、私有 context、target 和 task/packet/session/intent 绑定哈希。

同一 `(projectId, dispatchKey)` 且相同 `sessionId`、`intentHash` 会返回原任务并且不会再次调用 `bindPacket`。`intentHash` 不包含尚不存在的 `taskId` 或 `packetHash`。不同 intent 或跨 session 重用 dispatch key 会失败。`readByDispatch` 提供路径无关的重放读取，使服务在创建新 Pi context 前先恢复原分配。

## Worker 合约

worker 先调用 `listClaimable(projectId?)`，再调用：

```ts
claim(projectId, taskId, workerId): StudyAgentClaim | null
heartbeat({ projectId, taskId, workerId, claimToken }): StudyAgentClaim
readContext(claim): { agentSessionId, sessionFile }
markLaunching(claim): StudyAgentQueueTask
markRunning(claim): StudyAgentQueueTask
markNeedsInput(claim, detail): StudyAgentQueueTask
complete({ ...claim, report }): StudyAgentQueueTask
fail(claim, detail): StudyAgentQueueTask
acknowledgeCancellation(claim, detail): StudyAgentQueueTask
reconcile(claim, { status: "cancelled" | "failed" | "needs-input", detail }): StudyAgentQueueTask
```

队列阅读任务可由当前项目成员按优先级重排：

```ts
setPriority(scope, taskId, expectedPriority, priority): StudyAgentQueueTask
```

该调用要求 task 属于同一项目且 session 仍是当前 phase 的成员；`expectedPriority` 是 `-100..100` 的整数 CAS，新的 `priority` 也必须在此范围内。只有尚未领取、状态为 `queued` 或未启动的 `admitted` 阅读任务可以修改。调用只更新 priority、`updatedAt` 和诊断记录，packet/context/evidence identity 不变；`listClaimable` 与 `claimNext` 按新的 priority 降序取件，运行中的模型不会被抢占。

所有项目共用一个未过期租约，因此不同项目不能同时派发模型请求。`claim` 返回 `null` 表示该全局槽正被占用；不同 worker、过期 token 或失去的租约都会显式失败。`listClaimable` 先清理过期租约：尚未经过 durable launch boundary 的 admitted 任务可重新开始，launching/running 任务转为 `reconciling`，绝不自动再次发送模型请求。reconciling 任务通过同一全局槽被领取、检查已有 Pi journal：有同一 packet 的持久报告可 `complete`，没有报告必须 `reconcile(...needs-input)`。

未知的 provider 状态必须在 durable launch boundary 之后调用 `markNeedsInput`；该方法使用租约和 Host revision CAS，在一个 savepoint 内将 launching/running 先转为 `reconciling` 再转为 `needs-input`，记录诊断并释放租约。它不会重新发送模型请求；admitted 任务应先调用 `markLaunching` 建立边界。

取消优先于迟到的报告。任务取消后，worker 只可确认取消；任何 `complete` 都失败，因而不会更新学习产物。

## 报告、证据和学习产物

报告完整保存 `summary`、学术 `outcome` (`passed`、`failed`、`inconclusive`)、findings、notes、unresolved、target 和冻结 citations。`outcome` 描述学术结论，不能被误读成 worker 成功状态；成功写入报告后 Host 任务才转为 `succeeded`。空 findings 或 notes 合法，避免要求模型捏造笔记。

每个 finding/note 的 `evidenceIds` 必须是本 packet 冻结的 source chunk id。队列对 packet、evidence、context、target、report 使用规范化内容哈希；report hash 明确覆盖除 `reportHash` 字段外的报告主体。任一 JSON、报告或 packet binding 被篡改都会以 `CORRUPT_STATE` 失败。

完成在同一事务中保存报告、验证当前 review target、确认每个 frozen source hash 仍是当前版本、检查每个 frozen source locator，并写入自动知识节点、Agent notes 和关系。一个 note 引用多个 source 时，系统为每个不同 `(sourceId, sourceHash)` 建立 node/note，并以 `refers-to` 图边关联；跨来源边会在任一端点来源更新时标记 stale，避免遗漏失效传播。阅读任务为 packet 中每个证据 chunk 写一个 `read` checkpoint。`review` 任务在 Host task 以同一 frozen authorization 成功后，继续调用 `recordIndependentReviewFromFrozenTask` 写入唯一 canonical review，target、版本和来源都取自队列冻结记录；canonical status 将 failed 报告或 moderate/major finding 记为 `failed`，unresolved、uncertain 或 inconclusive 记为 `inconclusive`，只有没有 blocker/unknown 才是 `passed`。canonical findings 带有 summary、finding 引用的 evidence id 和 unresolved 文本。报告、checkpoint、知识图、Host 状态、canonical review 与租约释放共享同一事务，任一步失败都会全部回滚；重放不会补写旧任务的 review，也不会产生重复 review。人工 note 从不被替换。已保留任务用冻结 authorization 继续执行，仅验证项目成员而不重新依赖当前 Study/Research phase，因此 phase 切换不会丢失已批准的学习工作。
