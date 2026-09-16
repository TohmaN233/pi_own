# StudyResearchHost 领域内核

`StudyResearchHost` 在 LearningHarness 已打开的同一 `node:sqlite` `DatabaseSync` 上保存 Study / Research 状态。它只信任 `pi_project_workspace` 和 `pi_project_member` 的成员关系；所有 `Scope` 读写验证 phase revision。`currentPhase(projectId, sessionId)` 仅供页面重开的只读引导，`bindSession` 只在用户显式进入 Mode Pack 时调用，`setPhase` 使用 CAS。

本包保存领域意图、版本和证据，不读取任意本机路径、不启动进程、不执行代码，也不声称已经提供 OS 隔离、资源限额或 PDF 渲染。这些由可信 UI import adapter、worker 和 queue owner 实现。

## 可组合事务

所有写入用内部命名 SQLite `SAVEPOINT`。因此 composition root 可在外层 transaction 中原子完成 `reserveStudyTask` / `reserveTask` 与 execution queue 的 payload、资源预约写入；外层 rollback 会同时回滚 Host reservation。Host 不公开任意数据库 callback 或自身表的写权限。

## 来源与阅读

`registerSources(scope, inputs, expectedProjectRevision)` 是用户选择资料后的批量导入 API：整批先验证、在一个 savepoint 内写入，任一资料无效时没有半批残留。相同 `{ sourceRoot, relativePath, contentHash }` 幂等且不递增项目 revision；一批新来源只递增一次。已存在的 `{ sourceRoot, relativePath }` hash 改变会返回 `SOURCE_UPDATE_REQUIRED`，不能隐式替换。`registerSource` 是单项兼容包装。

`sourceRoot + relativePath` 来自可信 UI adapter，支持项目 cwd 与论文目录不同；它不授予 Agent 本机路径读取能力。每个来源版本保存 parser、role、诊断、bounded chunk 正文、text hash 和 JSON locator。`readChunks` 使用 SQL `LIMIT/OFFSET` 并在每次读取时核验已存正文 hash。OMML/PDF 核查诊断一并持久化。

## 知识、笔记与来源更新

`commitKnowledgeChange` 只追加新 note、node、relation，绝不删除项目既有知识；连续保存保留稳定 ID、revision 和用户内容。已有实体只能通过带实体 revision 和 project revision 的 `editKnowledgeNote` / `editKnowledgeNode` 修改，旧 revision 返回冲突，不采用最后写入覆盖。编辑若仍绑定已 supersede 的 source version，会保持 `stale: true`；只有绑定当前 source version 或无来源的实体才能清除 stale。

`addKnowledgeRelation(scope, { fromNodeId, toNodeId, kind, expectedProjectRevision })` 支持连接同项目既有节点，并保存为 `author: user`、`manuallyEdited: true` 的无来源 relation。两端都必须属于当前项目；只遍历未 retirement 的 `prerequisite` 边拒绝环，其它 relation 可以成环。Agent 追加 relation 仅当两端 node 绑定完全相同的 `{ sourceId, sourceHash }` 时才继承这组来源；跨来源 relation 保持无来源绑定。

`proposeSourceUpdate` 仅备份、标记和替换同一 `{ sourceId, previousHash }` 的 entities。候选 node/note 只有显式 `replaceNodeId` / `replaceNoteId` 才能 CAS 替换对应的同来源、自动生成备份实体；replacement ID 必须唯一。省略 replacement ID 一律新建，绝不按数组顺序、标题或随机 ID 猜测匹配，也不删除未匹配的旧实体：它们保持 stale。用户 note 和手工 node 永不被候选覆盖；`editKnowledgeNote` 会持久化 `manuallyEdited: true`，因此即使原 note 是 agent 创建，之后也不能被 rebasing。

relation 同样保存 author、manual 标记、完整来源、revision、`stale` 与 `requiresReview`。旧版本的自动同来源 relation 在提案时标为 stale，因而退出 active graph；accept 追加绑定 candidate hash 的新边，旧边仍保留作可追溯历史。reject 用 backup 恢复旧自动边为 active。手工 relation、跨来源 relation 和 `author: unknown` 的 legacy relation 均不进入来源局部 backup，永不被这种更新退休；legacy relation 自动标记 `requiresReview: true`。候选映射、来源范围和 candidate prerequisite 无环检查在 supersede 现有 pending proposal、写入 candidate 版本或标记 stale 之前完成，因此无效候选不会改变项目 revision、知识或 pending proposal。`getSourceUpdateDetails` 在确认前提供候选来源、候选知识和受影响部分；`listSourceUpdates` 供更新中心读取。

确认时 Host 再比较受影响实体的 revision/hash。有人编辑则 `SOURCE_UPDATE_CONFLICT`，不会覆盖，必须重新计算候选。accept 只推广候选来源和局部自动知识；reject 只恢复受影响部分并保持 stale。临时 backup 在 accept、reject 或 supersede 后删除。同一已拒绝/已 supersede hash 可再次提案，候选版本会复用。

## Study、Research 与授权

Study 小任务由 `reserveStudyTask` 在 Study phase 冻结 `FrozenStudyTaskAuthorization`，保存 purpose、language、wall time 和 memory 限制，不需要研究计划/grant。Research `reserveTask` 固定 grant、计划 revision、语义摘要和 run manifest。切换当前 phase 不会修改既有任务。

Scope grant 保存计划的精确语义和当前引用来源 `{ sourceId, contentHash }`。新 plan 持久 `sourceReferences`，并要求它与 `sourceVersionHashes` 完全一致；同一个 hash 对应多个 source 的旧 hash-only plan 会明确拒绝，绝不挑选 SQL 的第一行。notes、无关来源、无关计划和普通项目 revision 变化不使 grant 失效；计划语义/revision 改变或精确引用来源切换后，新 reservation 失败。`scopeEpoch` 仅为既有存储兼容/观察保留，不参与 grant admission。

`grantScopeFromTrustedUserEvent` 和 `confirmResultFromTrustedUserEvent` 必须由已验证用户事件的 UI/Host adapter 调用；`userEventId` 在 grant 和 result confirmation 中持久化，字符串本身不是认证。

## 任务、检查与结果

任务有 project-local dispatch idempotency、CAS revision 和按 task revision 单调增加的 event sequence；`listTaskEvents` 按 sequence 读，重启后不依赖随机 UUID 顺序。预约不表示 worker 已启动。

可信执行 adapter 通过 `registerTrustedRunnerContext` 生成持久 producer identity。Research execution、validation 和 review reservation 都必须保存该 context；缺少 execution provenance 不能生成 result。validation/review reservation 保存 reservation-time target `{ kind, id, revision, hash, execution producer identity }`；callback 只能写入被冻结的 target，不能重定向。每条 validation/review 持久 task ID、冻结授权、完整 manifest、producer context 和 target。独立 review 比较稳定的 `producerIdentity`，不同 context ID 但同一 producer 仍不独立。

Queue 在 Research task 从 `queued` 进入 `admitted` 前调用只读 `assertFrozenResearchAuthorizationCurrent(authorization)`。该方法重验冻结 plan、grant、expiry/revocation 和精确 source references，不读取当前交互 phase，也不创建或续期授权；Host transition 本身同样执行这道门。

只有 Research execution 能产生 `ResearchResult`。确认会存 `confirmedUserEventId`。`scientificResultHash` 只覆盖 result ID/project/task/revision、classification、summary、limitations 和 manifest；确认、发布和其它 workflow 时间戳不改变它。完整持久 payload 仍由 storage payload hash 保护，读取 result 时同时重算 scientific hash。发布要求同一版本已确认、至少一项 passed validation 与 passed independent review，且没有 failed 检查。`listResults`、`listScopeGrants`、`listValidations`、`listIndependentReviews` 供 UI 只读查询。

## 可视化预留接口

`createVisualizationDraft` / `reviseVisualizationDraft` 需要 trusted adapter 为实际 Pi session mint 的 `creatorContextId`；缺少 provenance fail closed。它们保存 creator context/identity、code、bounded JSON `inputs`、Host 计算的 code/input hash、输入依赖 hash、环境 hash、owner phase 和 revision。visualization 可作为冻结检查 target，review 同样比较其 creator identity。本包不执行 code、不生成 SVG scene、不提供 iframe 隔离或数学 oracle；P3 renderer/validator 才负责这些能力。

## 定向验证

```powershell
node --test scripts/study-research-host.test.mjs
node_modules\.bin\tsgo.cmd --ignoreConfig --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --allowImportingTsExtensions --skipLibCheck packages\study-research-host\src\index.ts
```

定向测试使用真实 `DatabaseSync`，覆盖跨项目/phase CAS、来源根与诊断持久化、Study/Research 冻结、追加知识与显式编辑、来源局部 accept/reject/retry、grant 精确失效、trusted target/context、发布门、批量导入原子性、SQL 分页、event ledger 和外层 transaction rollback。
