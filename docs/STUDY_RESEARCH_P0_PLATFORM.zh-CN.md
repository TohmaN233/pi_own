# Study & Research P0：Windows 执行平台证据

本文件记录 P0 对本机 Windows 普通用户能力的实测。它不是执行授权，也不实现任务监督、任意 R/Python 运行、资源准入或沙箱。P1 必须在现有 Harness 生命周期内接入这些能力。

## 可复用接口

[`packages/study-execution-host/src/index.ts`](../packages/study-execution-host/src/index.ts) 导出：

- `detectStudyPlatform(workspaceDirectory?, {pythonExecutable?, projectPythonEnvironment?})`：只读发现当前 Node、Python 与 Rscript，以及 CPU、内存、GPU、工作区磁盘和 CPU 负载。Python 环境类型与项目归属分别记录；仅显式指定预期项目环境，且 realpath 后 prefix 和解释器路径一致时，才报告属于该环境。未配置时绝不依据 prefix 差异猜测归属。缺少或检查失败会写入类型化的 `StudyCapability`/`diagnostics`。
- `suggestStudyResources(report)`：返回 P0 的单并发保守起点。它明确返回 `null` 的 CPU、内存和墙钟硬限额，并禁用 GPU 调度；该建议不是未测机器上的“安全比例”。
- `probeWindowsExecutionCapabilities({ artifactDirectory })`：仅运行包内固定 Node 夹具，隐藏地启动一个脱离 launcher 的 worker 和其子进程，观察心跳后只对这个 worker PID 执行 `taskkill.exe /PID <pid> /T /F`。夹具最多运行 5 秒，结果和 PID 写入调用者给出的证据目录。

该 probe 不接受命令、代码、cwd、网络或环境变量，因此不能被作为任意科学代码执行器。其专用目录只是证据输出位置，不是访问控制。

## 本机实测（2026-09-12）

执行命令：

```powershell
node --test scripts/study-execution-platform.test.mjs
powershell.exe -NoProfile -NonInteractive -File .artifacts\study-research\p0-platform\job-object-api-probe.ps1
```

定向测试通过。本机检测结果写入被 Git 忽略的 `.artifacts/study-research/p0-platform/`，不会提交设备路径、硬件清单或容量数据。`latest-platform-observation.json` 的 `platform` 保存 version、detectedAt、OS release／architecture；进程证据保存在其 `probe.artifactDirectory` 指向的 `execution-probe.json`。

| 项目 | 实测结果 | 含义 |
| --- | --- | --- |
| Node | 当前进程的 `process.execPath` 与版本 | 应用进程启动时重新检测，不假定开发机路径。 |
| Python | 从显式配置或 `PATH` 发现的解释器、版本及环境身份 | 全局 Conda／Python 不能当作项目隔离证据。 |
| R | 从 `PATH` 或有限的标准安装目录发现的 Rscript、版本及库路径 | 检测只读；全局库不代表项目环境。 |
| CPU/内存 | 逻辑核、瞬时负载和可用内存 | 均为启动时观测，不能替代运行中预留或限额。 |
| GPU | WMI 枚举适配器；NVIDIA 显存只接受 `nvidia-smi` 证据 | AdapterRAM 不作显存依据；每项记录 memorySource 和解释，不等于 GPU 限制或调度预留。 |
| 磁盘 | 当前工作区文件系统的总量与可用量 | 仅作观测，不提交具体本机卷标和容量。 |
| 背景存活 | 通过 | launcher 退出后，隐藏 detached worker 和子进程仍存在且心跳递增。 |
| 进程树取消 | 通过 | `taskkill /T /F` 终止观测到的 worker 和子 PID；结果 `survivingPidsAfterCancellation: []`。 |
| Job Object API | 可用，未验证强制执行 | 临时 PowerShell/C# probe 成功 `CreateJobObject`，并在空 Job Object 上成功配置 64 MiB `JOB_OBJECT_LIMIT_PROCESS_MEMORY`；句柄随后关闭。 |
| CPU/内存/墙钟硬限额 | 未实现、未验证 | Job Object API 可访问不代表已对 worker 设置、分配且验证任何 CPU/内存/时间策略。controller 定时取消也不是硬墙钟限额。 |
| 文件、网络、凭据隔离 | 未实现、未验证 | 未创建 AppContainer/restricted token，也没有拒绝读取工作区外文件或拒绝网络的实测；专用输出目录没有安全含义。 |

Job Object API 原始结果在 [job-object-api-probe.result.json](../.artifacts/study-research/p0-platform/job-object-api-probe.result.json)，其 C# P/Invoke 夹具在相邻的 [job-object-api-probe.ps1](../.artifacts/study-research/p0-platform/job-object-api-probe.ps1)。这次 API probe 没有分配 worker，因此不能作为资源隔离验收。

## P1 准入边界

在以下能力实测通过前，Host 只能把本 P0 的 background/cancel 结果用于受控启动和取消；不得把它作为任意 R/Python、网络任务或不可信代码的准入依据：

1. 使用受审计的 Windows 原生/托管 helper 为每个 run 创建 Job Object，在分配 worker 前设置并查询回 CPU hard-cap、job/process memory 和 job-time 策略；验证一个小 CPU 夹具和小内存夹具的实际限制及退出原因。Job Object 文档明确支持 `SetInformationJobObject` 的 CPU 和扩展内存限制，但这不替代本机强制执行测试。[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 与 [Extended Limit Information](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)
2. 使用 Job 的内核 handle、启动时间和 completion port 做状态对账；取消应关闭/终止本 Job，不根据陈旧 PID 杀进程。`taskkill /T` 是 P0 实测的临时 controller 机制，不是持久监督服务。
3. 对需要文件或网络边界的执行，使用 AppContainer/LPAC 或经过同等拒绝测试的机制，以最小 capability 和专门 ACL 授予唯一输入快照与输出目录；分别证明工作区外读取、凭据读取和网络连接失败。Microsoft 的 AppContainer 文档说明无 network capability 时无网络访问，且文件访问须通过 SID/DACL 赋权。[Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
4. 在目标解释器（尤其 R 与 Conda Python）下重复启动、限制、取消和拒绝测试。一个能创建 AppContainer profile 或 Job Object 的普通用户账户，不证明该解释器、DLL、运行时或所需输入已被最小权限策略正确允许。

P0 不安装 R/Python 包、不修改全局 R 库、不创建持久 AppContainer profile，也不改变系统配置。
