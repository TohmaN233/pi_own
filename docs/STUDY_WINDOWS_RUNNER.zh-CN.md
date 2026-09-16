# Windows 受限研究运行器（P0）

`packages/study-execution-host/src/windows-runner.ts` 提供普通 Windows 用户可运行的、有限资源的脚本执行边界。它不是通用 shell：调用者只能选择 `node`、`python` 或 `rscript`、一个绝对可执行文件、一个绝对脚本文件，以及有限的输入文件。没有命令行参数、shell 字符串、继承环境变量、挂载目录或网络开关接口。

## 提交、持久化和启动

Host 必须先调用 `prepareIsolatedWindowsRun(request)`。此阶段只会在 `runRootDirectory` 下创建运行时/输入快照、每个快照文件的 SHA-256 清单、已绑定的 `control/config.json`，以及可 JSON 持久化的 `IsolatedWindowsRunHandle`；它不创建 worker 进程。Host 应把这个 handle 和自己的 `launching` lease 在同一原子持久化动作中保存。

然后调用 `launchPreparedIsolatedWindowsRun(handle)`。它先用 `launch.claim` 排他占位，发布含配置绑定和取消令牌哈希的 `launching` 收据，才启动 detached C# supervisor。相同 handle 的第二次调用只读取/reconcile 已有收据，绝不再次启动。崩溃后的宿主应调用 `reconcileIsolatedWindowsRun(handle)`；若收据仍是 `launching` 或 `running`，它是待协调状态，不得盲目重试启动。`startIsolatedWindowsRun` 只是 prepare 后立刻 launch 的便捷封装，不适合需要持久化意图的 Host。

`cancelIsolatedWindowsRun(handle)` 需要 handle 内未散列的取消令牌。C# supervisor 会验证其 SHA-256 后写入取消请求，并用 Job Object 结束整个进程树。收据保留 `failed`、`cancelled`、`limit-reached`、退出码、创建时间、输出截断情况及 profile 清理结果，即使 launch 失败也会留下终态。

## 实现边界

每次 launch 会创建临时 AppContainer profile，并把已哈希的 runtime/input 副本放进该 profile 的私有目录。worker 使用没有 capabilities 的 AppContainer token：不向 `G:\\`、工作区祖先目录或任何全局 ACL 授权。runtime 与输入副本为只读；profile output 是唯一被授予修改权限的目录，且 profile 与私有工作目录会在终态清理。

supervisor 在恢复线程前创建并配置 [Windows Job Object](https://learn.microsoft.com/windows/win32/procthread/job-objects)：`KILL_ON_JOB_CLOSE`、每进程/整个 Job 内存硬限、CPU hard cap 和 wall-time。stdout/stderr 通过 supervisor pipe 回收且有字节上限。运行环境是固定的最小环境块；不会继承父进程的 token、PATH、代理或 secret。Node 采用 `--preserve-symlinks-main`，Python 采用 `-S` 与受控 `PYTHONHOME`，R 使用受控 `R_HOME`/`R_USER`/临时目录。

输入和 runtime 中的 reparse point 会被拒绝。Node 仅快照所选 `node.exe`。Python 仅快照所选解释器、顶层 DLL、`DLLs` 和 `Lib`（明确排除 `site-packages`）；这证明标准库模式，不等于 NumPy、SciPy 或任何用户包已获准。后续项目环境工作项必须把已选择 venv/conda 环境的所有依赖文件作为显式受控快照/manifest 引入，不能把当前用户环境隐式带入。

### root 退出后的进程树收口

root process 发出退出信号后，runner 不会只按 `JobObjectBasicAccountingInformation.ActiveProcesses` 判失败。Windows 可以在 root 已经 signalled 的短窗口内继续把它计入该聚合值。runner 会在有界观察窗口内反复记录 `JobObjectBasicProcessIdList`、Job accounting 和 Toolhelp 候选关系；每个 Job PID 都带 PID、镜像名、创建时间、父 PID 和实际 liveness。收据中的 `RootExitDiagnostics` 是此证据的持久化结构。

只有观察窗口结束时没有活着的非-root Job member、也没有经 `OpenProcess`/wait 确认仍活着的 Toolhelp descendant，退出码 0 才可以成功。`ToolhelpCandidates` 持久化候选 PID、镜像、父 PID、创建时间、liveness、接受/拒绝结论与检查错误。数字父 PID 本身不构成后代关系：若当前 root PID 仍可检查，runner 先验证它对应收据中的 `ProcessCreationFileTime`；随后只扩展创建时间严格晚于 root 的候选。PID 已复用、创建时间缺失或不晚于 root 的候选会带拒绝原因且不会使无关进程把本次运行判失败。Toolhelp snapshot 中已消失（`ERROR_INVALID_PARAMETER`）的 PID 视为已退出；其余无法检查的 distinct Job member 仍 fail-closed。临时 console/child 进程可以在窗口内自行退出；仍在运行的 member 会导致 Job 整体终止并保留失败收据。这样既不会把 root accounting lag 误报为 orphan，也不会把陈旧的 Toolhelp 表项误判成活着的后代。

### 长路径快照

helper 编译时会嵌入 Windows `longPathAware` manifest，并在同一私有 helper 目录写入 .NET 的 `Switch.System.IO.UseLegacyPathHandling=false` 与 `Switch.System.IO.BlockLongPaths=false` 配置。这是针对整个 runner 进程的路径能力声明，覆盖调用方 artifact root 下的 runtime/input 快照和其深层文件；它不改写、截断或映射用户提供的路径。定向回归在同一深层 artifact root 上先用不含该声明的原生 helper 得到 `PathTooLongException` / `ProcessId: 0` 失败收据，再用发布的 helper 成功完成相同的 Python 快照和执行。

## 已验证与未开放的语言

定向夹具实测 Node 的 AppContainer 无法读取或改写 `G:\\` synthetic sentinel，无法改写输入脚本或伪造 control 收据；父进程 secret 不会继承；可在 profile output 创建文件和子目录；面对实际监听的 loopback TCP fixture 也不会建立连接。Python 3.13 的 `-S` 标准库夹具实际输出 `python-result:4`。这些结论只适用于该 runner 的快照路径和无 capability AppContainer，不是 Windows 上所有子进程的泛化承诺。

当前机器的 stock R 4.5.1 只能经私有 `r-appcontainer-launcher` 准入。R 的 Windows `normalizePath` 依赖 `GetFinalPathNameByHandle`；该 API 的 DOS volume-name 查询在 AppContainer 内需要访问 `\\GLOBAL??`/Volume Mount Manager，普通文件 ACL 不能补齐这一内核边界。兼容 launcher 在初始化 R 前只替换私有 `R.dll` 的两个 `GetFinalPathNameByHandle` IAT 入口：它从已验证的 NT volume 名得到路径，再映射回同一受信任输出盘的 DOS 形状路径。它对每次执行写出 `r-compatibility.json`，绑定 adapter/R.dll SHA-256、IAT patch、hook 调用数、初始化和脚本求值结果；任何 patch/attestation 异常仍 fail-closed，不会退回无 AppContainer 的 R。定向测试实际运行 R 4.5.1 并要求该 attestation 的 `hookCalls > 0`、`initialized/evaluated=true`。这只证明该受控 snapshot 与兼容 adapter，不是对任意 R runtime 或 unrestricted Windows 进程的保证。

## 本机定向验证

运行：

```powershell
node --test scripts/study-windows-runner.test.mjs
```

测试会生成 `.artifacts/study-research/windows-runner/tests/latest-test-evidence.json`。它验证两阶段 launch claim、Node 文件/环境/网络边界、Python 标准库、R compatibility adapter attestation、错误取消令牌拒绝、进程树取消、wall-time、Job 内存限制、父 launcher 退出后的 reattach/cancel，以及最终收据和 profile 清理。

root 退出的定向回归运行：

```powershell
node --experimental-strip-types --test scripts/study-root-exit-diagnostic.test.mjs
```

它把所有临时 run 放在 `.artifacts/study-research/root-exit-diagnostic/runs`，重复运行正常 root 退出，并保留最后一次正常、短暂 child 和持续 child 的收据，用来复核 accounting lag、短暂成员收口和真实 orphan 的 kill-on-failure。测试还会编译并执行原生 stale-parent 创建时间夹具，以及把无 long-path capability 的真实 pre-spawn 失败和发布 helper 的成功收据分别写入该 artifact 根目录。
