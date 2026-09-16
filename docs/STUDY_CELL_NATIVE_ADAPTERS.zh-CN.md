# R / Python Native Cell Adapters

`createNativeWindowsCellAdapters({ runRootDirectory, cpuRatePercent })` 返回两个 `StudyExecutionAdapter`：

- `native-windows-python-project-venv-v1`，仅接受 `language: "python"` 和已冻结的项目 venv inventory；
- `native-windows-r-global-library-v1`，仅接受 `language: "rscript"` 和已冻结的 R_HOME / 已选 `.libPaths()` package inventory。

Detached coordinator CLI 已将它们和 Node adapter 一起注册。adapter 不会从 PATH、当前 Python/R 安装或交互状态推断环境。

## Durable preparation identity

`createPreparationIntent(input)` 是同步且无 I/O 的分配步骤。它只在 queue-private handle 中生成 `{ runId, cancelToken, runRootDirectory }`；public summary 不含路径或 token。coordinator 必须先持久化该 intent，之后以 `prepare(input, intent)` 调用 adapter。adapter 严格验证 adapter kind、UUID 与既配置的 absolute run root，不能为重启后的同一 admission 重分配目录或取消 capability。保留无 intent 的参数形式只为旧 adapter 接口兼容，生产 coordinator 的 native cell admission 必须传入已经持久化的 intent。

已持久化 intent 在 prepare 之前或 materialization 中收到取消时，coordinator 调用 `abandonPreparation(intent)`。它只把 identity 交给 runner 的 fenced recovery/cleanup：从未 materialize 的 intent 产生零用量 cancelled receipt；完整但未 launch 的 snapshot 被清理并报告实际清理磁盘用量；有 launch claim、活跃 materializer 或不完整所有权日志都返回可重试的错误，绝不删除可能已执行的目录。

## 冻结与执行证据

adapter 保留 `FrozenExecutionPayload.program.content` 作为原始用户代码，因而它仍与 `RunManifest.codeHash` 一致。它解析已冻结的 canonical parameters，并调用 `compileStudyCellProgram` 生成确定性 wrapper；wrapper hash 和 protocol 记录在 queue-private prepared handle，不能替换用户代码 hash。

每个 frozen input 先写入 private staging 的 `input-N.ext`。wrapper 只把用户 alias 映射到这些文件名：Python 用 `__file__` 的父目录，R 用经过兼容 launcher 验证的 `R_COMPAT_PROGRAM`。caller 没有能提供 runtime input path 的 API，因而不能把运行时读入指向 staging 之外的路径。

private staging 只用于让 native runner 复制 bytes，不是 durable artifact。每次 prepare 在 `private-cell-payloads/<queueJobId>/<payloadHash>/run-<stagingIdentity>` 创建独占目录；有 durable intent 时 `stagingIdentity` 就是已持久化的 `runId`，无 intent 的旧接口调用使用新的 UUID。相同 queue job/payload 的并发 prepare 因此不会共享或删除对方的 wrapper/input。runner 完成 immutable input snapshot 后，adapter 在返回 prepared handle、callback rejection、runner preparation/verification failure 和后续 cancellation path 前都清除该叶目录。

清除不使用 recursive remove。adapter 记录新建目录和每个新建 regular file 的 filesystem identity；清除时重新 `lstat`/`realpath`，拒绝 reparse point、目录/file identity 变化、额外条目和越出原 payload root 的路径，再逐个 unlink 已记录文件并 rmdir 空目录。无法建立该证明时保留文件并抛出 `CELL_STAGING_CLEANUP_FAILED`，其中包含原 prepare 失败及 cleanup/abandonment 失败。若 runner 已成功准备，cleanup failure 还会 fenced-abandon 该 runner；因此不能把未知 staging 路径留给可 launch 的 runner，也不会删除另一个并发 prepare 的数据。

prepare 按顺序执行：

1. `verifyStudyExecutionEnvironment` 重算 descriptor、验证严格排序 inventory、regular-file/reparse 限制和每个源字节 hash；
2. runner 带同一 `environment`、同一 executable、wrapper 和 private input snapshot prepare；
3. 再次验证源环境；
4. 读取 private `control/config.json`，验证 `EnvironmentAdapterKind`、`EnvironmentDescriptorHash`、每个 `Files` snapshot byte hash，以及 Python/R inventory 的 runtime hash multiset；R 还验证 compatibility launcher 和 `R.dll` 的 config hash binding。adapter 还要求 `ProgramPath` 为唯一预期的 `input/program.<ext>`，并要求它和每个唯一 `input-N.<ext>` 都在 `Files` 中以 frozen wrapper / frozen input 的 exact hash 出现，再重新读取这些 snapshot bytes 核验；staging 在 copy 前的任何修改都会使 prepare cleanup 后失败。

第 2–4 步失败时 adapter 调用 `abandonPreparedIsolatedWindowsRun` 删除未启动 snapshot；若清理也失败，会抛出同时保留验证与清理信息的 `CELL_PREPARE_CLEANUP_FAILED`。随后同一 prepare 的 staging cleanup 仍会执行；它失败时 `CELL_STAGING_CLEANUP_FAILED` 保留原错误。它不会回退到环境 hash 字符串、部分复制的 runtime 或当前机器解释器。

queue 的 `cpuMilliCores` 按本机逻辑核数换算为 Windows Job 的整机百分比，向下取整且不超过 adapter 的 `cpuRatePercent` ceiling。低于 Job 1% 粒度的请求会被拒绝。requested milli-core、logical core 数和实际 percentage 都存入 private handle 与无 secret 的 public summary。

正式 detached worker 将 adapter ceiling 设为 100%，因此不会额外把已获准的资源请求压成 25%；实际 Job percentage 仍完全由该 job 的 `cpuMilliCores` 和本机逻辑核数向下取整决定。环境快照准备单独计时，不能冒充用户程序运行时间：前端 Python evidence 的 `createdAt` 05:45:46 至 `observedAt` 05:46:46 约为 60 秒，而 worker 实际 wall time 为 678ms。

## 终态、日志和 artifacts

launch、poll、cancel 与 prepared cleanup 直接使用同一个 `IsolatedWindowsRunHandle`。terminal receipt 的 process ID、creation time 和 config binding 被作为 coordinator 所需的正 process evidence；stdout/stderr/error 仍经 coordinator 的 redaction 进入普通日志结果。

user artifacts 只位于 queue-private `handle.outputDirectory`，即 runner 的 `run-<id>/output`。提供两个受信 helper，二者都要求 runner 已有 terminal receipt：

```ts
const descriptors = await describeNativeCellOutputArtifacts(preparedHandle);
const { descriptor, bytes } = await readNativeCellOutputArtifact(preparedHandle, descriptors[0]);
```

descriptor 只有 relative path、bytes、sha256、media type 和 `contentDisposition`。单文件上限为 64 MiB，与 native runner 的 output 预算一致；未知、HTML 和 SVG 均标记为 `attachment`，不能作为 HTML 响应直接嵌入。PDF 预览由上层把已验证 bytes 包进 JSON/base64，不提供猜测路径的二进制文件 URL。

read 必须收到 list 返回的完整 descriptor，重新列举并验证 exact hash/size。枚举和读取均先 `lstat` 拒绝 link，再 `realpath` 并检查 canonical path 仍位于 canonical output root；打开文件后在同一 handle 上对读取前后 stat identity 做核验，再计算 hash。目录或文件在此过程中被替换即 fail closed。它拒绝 traversal、absolute path、symbolic link、过大文件和 `stdout.log`/`stderr.log` aliases。该 helper 本身不授权任何用户，Host/queue/Harness 必须先按 project/task/cell 映射获取 private prepared handle，且不能向客户端暴露 handle、cancel token 或 output path。

## 聚焦验证

`node --test scripts/study-cell-native-adapters.test.mjs` 建立一个临时项目 venv，并对 R global inventory 做真实 AppContainer run。它验证 Python 与 R 的 frozen parameters/input alias/numerical output，R PNG plot，Python failure/cancel receipt，tampered descriptor 在 process 前失败，以及 terminal artifact descriptor/read 的 traversal 拒绝。它还验证 success、callback rejection 和 cancellation 后没有 private staging files；将 staging 目录替换为非目录时必须保留 actionable cleanup error，并确认已准备 runner 已被 abandoned。实际 receipt 保存为 `.artifacts/study-research/cell-native/r-python-evidence.json`。
