# R 4.5.1 AppContainer 兼容运行器

本机 `C:\Program Files\R\R-4.5.1\bin\Rscript.exe` 现在可通过
[`windows-runner.ts`](../packages/study-execution-host/src/windows-runner.ts) 在普通用户的无
capability AppContainer 中运行有限的标准 R 统计与绘图脚本。该结论仅覆盖本文件列出的
R 4.5.1 runtime 快照、`stats`/默认图形设备和定向夹具；它不代表任意 CRAN/Bioconductor
包、用户库或项目包环境已经准入。

## 根因与受限适配

R 的 Windows `normalizePath` 会在已打开文件句柄上请求
`GetFinalPathNameByHandle(..., VOLUME_NAME_DOS)`。该 DOS volume 查询在无 capability
AppContainer 中因全局 volume namespace 被拒绝，即使 private runtime 的目录 ACL 已允许
读取。普通文件 ACL 不能解决该内核 namespace 边界。

`r-appcontainer-launcher.c` 是每次 R 运行快照一份的原生 launcher。它不链接或修改
全局 R，也不注入其他进程：launcher 只加载 private `R.dll`，在调用 embedded-R API 前
仅替换这个模块的 `GetFinalPathNameByHandleW/A` IAT 项。若不是恰好一对预期 import，或
R.dll／adapter 哈希没有通过 runner manifest 验证，它会失败并留下失败收据。

hook 对 R 请求的 DOS canonical path 改用 `FILE_NAME_NORMALIZED | VOLUME_NAME_NT`，并只在
返回路径有 supervisor 预先验证的同一 NT device prefix 时，把该 prefix 映射回 profile
所在的受信任 DOS drive。supervisor 用 private profile output 中的临时 probe handle 捕获该
prefix，probe 立即删除；不会查询或授权工作区、`G:`、全局 R 安装或网络。hook 仍要求 R
已取得一个可访问的文件 handle，因此不扩大 AppContainer 的文件可达性。每次运行会收集
`r-compatibility.json`，其中有 mode、adapter/R.dll SHA-256、IAT 状态、hook 次数和 embedded-R
初始化／求值状态。

`R_HOME` 指向 private runtime 快照，`R_USER`、HOME 与临时目录均指向 private output。
runtime/input 为只读，只有 profile output 可写。终态时 C# supervisor 将普通文件输出回收
到 host output，再删 private workspace 与 profile。`outputBytes` 是 stdout、stderr 与已回收
worker 文件的总字节数；`outputFiles` 相应包含两份日志与回收文件数，方便队列计费和结果读取。

## 两阶段 API 与取消

`prepareIsolatedWindowsRun` 会生成 runtime/input 快照、文件 SHA-256 manifest、config 和持久
handle，但不创建 worker 或启动进程。Host 必须持久化 handle 后调用
`launchPreparedIsolatedWindowsRun`。

`abandonPreparedIsolatedWindowsRun(handle)` 与 launch 竞争同一个排他 `launch.claim`：赢家写
`disposition: "abandoned"`，只删除经 config 及 run id 验证的 `run/runtime` 和 `run/input`，保留
`control/status.json`、output 和 helper。它返回 `cancelled` 状态、`wallTimeMs: 0` 和真实
`preparedCleanup` 文件／字节数。若 launch 已先获得 claim，abandon 会拒绝，调用者必须
reconcile 或 cancel，不能删除任何路径。launch 观察到 abandoned claim 时只返回该终态，绝不
启动 worker。

worker 已启动后，`wallTimeMs` 用 C# `Stopwatch` 从恢复 AppContainer 子线程到终态测量；启动
前失败与未启动 cleanup 为 0。Job Object 继续负责 CPU hard-cap、memory limit、wall-time 和
`KILL_ON_JOB_CLOSE` 的进程树终止。

## 定向验收

运行：

```powershell
node --test scripts/study-r-appcontainer.test.mjs
```

测试使用真实的 stock R 4.5.1 和 Rtools45 现有 GCC（只以进程局部 PATH 编译 adapter），验证：

- `library(stats)`、mean、variance、`lm`、`pnorm`、`set.seed` 可重复；
- private R runtime、输入脚本和 output 的 `normalizePath(..., mustWork=TRUE)` 都成功，缺失路径仍报错；
- PNG/PDF 和普通 output 文件被有界回收，attestation 的双哈希与 config 一致；
- synthetic `G:` sentinel 的读写、输入改写、control 伪造和实际 loopback TCP 连接都被拒绝；
- prepared cleanup 与 launch 的 claim 竞争不会发射重复 worker；Node Job fixture重复验证 wall-time 和取消；
- profile/workspace 终态删除，同时 stdout/stderr、图形和 attestation 留在 host output。

最近一次定向运行的机器可复核数据写在
[`latest-evidence.json`](../.artifacts/study-research/r-appcontainer/test-runs/latest-evidence.json)。

## 未开放能力

R 的用户库、第三方包、安装过程、编译包和项目专属 R environment 未获支持；不得把这项
统计/图形夹具证据外推为任意包支持。Python 仍只证明受控标准库 snapshot，当前 runner 也不
把 `venv\Scripts\python.exe` 自动识别为完整项目环境。后续环境任务必须显式选择 runtime，
把依赖目录及文件哈希加入受控 manifest，并在同样的 AppContainer 拒绝测试下重新验收。
