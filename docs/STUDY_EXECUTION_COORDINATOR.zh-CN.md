# Study Execution Coordinator

`StudyExecutionCoordinator` 是脱离页面与交互回合运行的受信 Node 协调器。它通过 `LearningHarness.createStudyExecutionCoordinator(...)` 复用同一个 Harness SQLite 连接、Study & Research Host 和执行队列；它不向产品 API 暴露数据库、预备句柄、取消令牌或环境路径。

## 入口与调用

Harness 的受信组合入口为：

```ts
const coordinator = harness.createStudyExecutionCoordinator({
	coordinatorId: "study-worker-1",
	adapters: [createNativeWindowsNodeAdapter({ runRootDirectory, cpuRatePercent: 25 })],
	artifactDirectory,
});
await coordinator.tick();
```

`tick()` 先收回过期 lease，再恢复已有 payload 的 `reconciling` 项和本进程仍持有的项，最后最多认领一个新任务。单个 coordinator 不允许并发 `tick()`，因此 heartbeat 后的 claim revision 会成为后续 queue 操作的唯一 revision。连续服务可使用：

```powershell
node scripts/study-execution-coordinator.mjs --database <SQLite绝对路径> --run-root <运行目录绝对路径> --artifact-dir <工件目录绝对路径> --watch
```

脚本只输出本轮的 `claimedJobId` 与 `reconciledJobIds`。部署方可将这个普通 Node 进程作为 Windows 隐藏、detached 的 worker 启动；运行本身仍由 Windows AppContainer runner 隔离。Coordinator 不依赖页面、浏览器 session 或交互 phase 保持不变。

Web 后端应调用 `ensureDetachedStudyExecutionCoordinator(database, options)`，其中 `options` 明确给出同一 Harness SQLite 的 `databasePath`、可信 `scriptPath`、`runRootDirectory`、`artifactDirectory`，并可指定 `coordinatorId`、Node 路径、tick interval 与 worker lease。它在单个 `BEGIN IMMEDIATE` 内检查现有 lease 并写入新的 `starting` token；未过期的 `starting` 会占住启动权，绝不会被并发请求覆盖。返回值只有 `started`、`already-running`、`already-starting` 或 `reconciling` 和 `ready: false`，不宣称子进程已准备完成。

子进程带着随机 token 自行调用 `activateDetachedWorker`，再独立 heartbeat。持久记录同时保存 PID、Windows creation-time ticks 和 token：PID 重用不会被误认为原 worker。creation identity 无法确认时，后端得到 `reconciling` 并等当前 lease 过期后再 fenced restart，不会盲目启动第二个 worker。watch loop 对单个 queue/tick 异常写入可检索的 `lastError` 后继续；失去 process fence 才退出。

## 原子入队和冻结 payload

在受信 admission 的同一个外层 SQLite 事务中，按以下顺序调用：

1. queue 创建 `execution` 或 `research` job；
2. code-cell 将 run 绑定到 job；
3. `coordinator.persistPayload(queueJobId, frozenPayload)`。

`persistPayload` 在已有事务内使用 SAVEPOINT，绝不会提交或回滚 owner 的外层事务。回滚因此同时移除 job、cell 绑定和 payload，tick 永远不能认领缺少 payload 的孤儿 job。对同一 job 重放相同 hash 是幂等的；任何不同 payload 都以 `PAYLOAD_CONFLICT` 失败。

`FrozenExecutionPayload` 是不可变的执行证据，包含 task/project/session identity、完整 `RunManifest`、原始用户 cell code 和其 `codeHash`、规范化参数 JSON、每个 source input 的 frozen bytes 与哈希、环境 descriptor 以及输出上限。写入和读取都重新验证：manifest、代码、参数、input bytes、descriptorHash 与 executable binding 必须逐字节一致。环境最多 10,000 个显式文件；这个上限容纳当前完整 R 运行时的 4,465 个文件，同时仍阻止无限制 descriptor。

R/Python 的 cell compiler 可以保存其 wrapper 的 `compiledProgramHash` 于 queue-private prepared handle；它不能替换原 cell `program.content` 或 `manifest.codeHash`。运行前没有可验证的 wrapper 或环境字节时，任务失败而不会回退到当前机器环境。

## 生命周期、恢复和取消

协调器严格调用 queue 的 `claim -> prepare -> persistPreparedHandle -> beginPreparedLaunch -> launch -> confirmRunning -> recordTerminalReceipt`。长时间 prepare、launch、poll 和 prepared cleanup 期间会保持 lease heartbeat，并使用 heartbeat 返回的最新 `claimRevision`。因此慢速 R runtime snapshot 不会因旧 lease 被其他 worker 接管。

在任何准备 I/O 前先分配并持久化 queue-private preparation identity；准备完成后将返回句柄更新到同一个记录。中途重启可打开原 identity 的完整快照，部分准备失败须先证明清理完成再释放 reservation。重启、超时或失去 launch reply 时，queue 把任务转到 `reconciling`；adapter 使用相同原生 run identity 核对或恢复 supervisor，不生成新实验。prepared 状态收到取消后，协调器通过 `acquirePreparedCancellation` 取得同一私有句柄并调用 runner 清理；launching/running 取消由 runner 返回真实 terminal receipt。canonical claim／journal 已改为原子发布；supervisor 在环境校验前持互斥锁，核对 run/config/token 绑定的结构化取消请求。强制 30 秒校验延迟时实际取消 79 ms、未启动 worker，限定范围独立复审与主验收通过。运行时复制期间的取消检查仍在恢复 worker 前生效，复制延迟不冒充执行时间。

首次 poll 已是 `succeeded`/`failed`/`limit-reached` 时也不能捏造 `running`。success 或 limit receipt 必须带相关的真实 process evidence，Node adapter 要求 runner 给出 process ID、creation time 和 config binding correlation，才能先确认 `running` 再记录终态。状态不明时留在 `reconciling`，不会盲目重启。

## 环境与可见结果

`native-windows-node-v1` adapter 只接纳 Node payload。它在 prepare 前后验证 environment descriptor 的所有文件，并按唯一快照位置核对 executable、program 及每个 input 的冻结 hash 与实际字节。Node 临时 payload 位于 run root 下的 `private-node-payloads/<queueJobId>/<payloadHash>/run-<durableRunId>`；runner 已复制并验证快照后，adapter 以 `lstat`、canonical path 和文件 identity 逐项确认，再只 unlink 自己写入的普通文件并移除该 leaf。路径、reparse point、identity 或目录内容发生替换时清理会拒绝继续并 abandon 已准备 runner，诊断保留准备、清理和 runner abandonment 的失败；绝不递归删除共享 payload root。R/Python 分别通过 `cell-native-adapters.ts` 的专用环境验证与确定性 wrapper 接入，不借用 Node adapter。queue 的 `cpuMilliCores` 按实际逻辑 CPU 数量换算为 Windows Job 的整机百分比并向下取整；低于 Job 1% 粒度的申请明确拒绝。产品 worker 的可信 ceiling 为 100%，由已准入的请求量决定实际限制，不再悄悄叠加 25% 上限。请求值、逻辑核数和实际百分比保存在 prepared summary 中；SQLite reservation 本身不能替代 OS cap。

`getPublicResult(queueJobId)` 只返回状态、实际 wall/disk usage、观察时间及 redacted stdout/stderr/error。它过滤 token、secret、password、credential、authorization、cookie 和 Bearer 值，并截断每条日志。私有 prepared handle、runner control path、cancel token、source bytes 和环境路径都不会经此接口返回。

终态 observation 先核查 claim／进程证据，并在同一个外层事务中结算队列与写公开结果；超额或取消后的真实队列状态决定公开状态。准备异常写入同一 Harness DB 的 private diagnostic，保留路径与堆栈用于定位、移除凭据；确定失败可清理后释放名额，不阻塞后续任务。另一个 API 实例登记的取消会在持有 claim 的 worker 下一轮被执行。

Pi Web 的 prebuild 生成独立 ESM bundle 到 `runtime/packages/study-execution-host/src`，连同本机 helper 源文件和 Skills 一起打包。安装后 worker 不依赖 monorepo 根脚本、tsx 或源仓库 cwd。构建在新临时目录完成后替换经路径验证的 runtime，防止已删除的旧 Skill 残留发布。

协调器使用 Host 的 coordinator read/冻结授权路径。已入队的 learning task 在用户将互动 phase 从 Study 切换到 Research（或反向）后仍可按其 frozen authorization 完成；Research task 还会重新验证 frozen plan、grant、依赖 source 与过期时间。该 read 路径不创建或续期任何 authorization。

## 聚焦验证

`node --test scripts/study-execution-coordinator.test.mjs` 覆盖真实 SQLite 的 payload 完整性（包括空文件）、外层 admission rollback、phase switch、first-poll terminal process evidence、准备态取消、lease/restart reconciliation、Node staging 的并发 run leaf、runner prepare 失败、替换后 fail-closed 清理与 runner abandonment、父 launcher 退出后的 detached worker activation，以及 Node AppContainer 端到端运行。测试调用时将 `TMP` 与 `TEMP` 指向 `.artifacts/study-research/node-staging/tmp`，避免创建范围外临时目录。成功的原生运行会把不含 secret 的实际 receipt 记录为 `.artifacts/study-research/node-staging/native-node-evidence.json`；detached spawn/fence 证据位于 `.artifacts/study-research/node-staging/detached-worker-evidence.json`。
