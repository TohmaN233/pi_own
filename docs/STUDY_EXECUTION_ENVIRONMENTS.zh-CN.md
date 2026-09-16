# Study 执行环境冻结

`packages/study-execution-host/src/environments.ts` 将可执行环境表示为与执行载荷一致的不可变描述符：

```ts
{
  adapterKind: "native-windows-python-project-venv-v1" | "native-windows-r-global-library-v1",
  executablePath: "C:\\...\\python.exe",
  files: [{ absolutePath: "C:\\...", sha256: "sha256:<64 hex>" }],
  descriptorHash: "sha256:<64 hex>"
}
```

`descriptorHash` 是 `adapterKind`、可执行文件路径和按绝对路径排序的全部文件哈希的稳定摘要。它必须等于 run manifest 的 `environmentHash`。`verifyStudyExecutionEnvironment` 会重新计算摘要、拒绝非正规文件和重解析点，并逐字节重新哈希全部源文件。描述符不是“Python 3.13”或“R 4.5”这类标签。

## Python 项目 venv

`createProjectPythonEnvironment({ projectDirectory, venvDirectory?, pythonExecutable? })` 只调用已有解释器的 `-I -m venv`。它不调用 pip、没有网络安装，也不会复用或修改已有 venv。`discoverProjectPythonEnvironment({ projectDirectory, venvDirectory })` 要求：

- venv 的规范真实路径位于项目目录内，路径中的重解析点被拒绝；
- `Scripts\\python.exe`、`pyvenv.cfg` 和解释器报告的 `sys.prefix` 明确证明其为该项目 venv；
- 基础解释器的可执行文件、DLL、`DLLs`、去除基础 `site-packages` 的标准库和已有 `Library\\bin`，以及所选 venv 的 `site-packages` 全部进入清单。

native runner 在 prepare 时和复制后各验证一次源清单。随后它运行私有基础解释器，并设置私有 `PYTHONHOME`、私有 venv `PYTHONPATH`、`PYTHONNOUSERSITE=1` 与 `-S`。因此不会从基础 Conda/Python 的全局 `site-packages` 或用户目录取包。输出的 `config.json` 绑定 `EnvironmentAdapterKind`、`EnvironmentDescriptorHash`、私有 site-packages 与 native DLL 路径；每一份复制文件也在 `Files` 中逐字节哈希。

在普通用户 AppContainer 的实际 Python 夹具中，CPython 会把私有基础 `python.exe` 的 Windows real-path 探测失败写入 stderr（`Failed to find real location of ...`）。runner 保留这条 stderr，不会过滤或把它解释成 venv launcher 回退；该夹具仍由已冻结的私有基础解释器、`PYTHONHOME`、`PYTHONPATH` 和逐字节清单执行。

`inspectPythonProjectPackages` 仅用 `importlib.metadata` 读取现有包。`planDependencyChanges` 只把请求分类为已安装、缺失或请求版本变更，并明确返回 `not-a-transitive-resolver`。它不解依赖、更改环境或安装任何包。

## R 全局库

`discoverRGlobalLibraryEnvironment({ rscriptExecutable?, packageNames? })` 从现有 Rscript 的 `--vanilla` `.libPaths()` 读取库路径，并始终冻结完整 R_HOME，所以 base/recommended 包（含 `stats`）可用。用户全局库可能远超 runner 的 256 MiB 私有快照上限，不能无界复制；因此外部包必须由界面显式给出 `packageNames`。

对于每个选择包，发现器读取已经安装的 `DESCRIPTION`，求 `Depends`、`Imports`、`LinkingTo` 在本机 `.libPaths()` 中的闭包；缺包直接失败并给出包名。它不访问 CRAN、不升级、不删除包，也不把该本机元数据闭包称为联网求解器。runner 只复制闭包目录到 AppContainer 私有 `R_LIBS`，并继续使用已验证的 R AppContainer 兼容启动器和 R.dll 摘要。

完整 R_HOME 4.5.1 在本机有 4,464 个文件。因此 coordinator 的环境文件上限必须高于这一有界清单，或采用经过同等逐字节验证的压缩清单；将 R 环境截断为只含 Rscript 会破坏隔离和可复现性。

## native 输出、进程树与限制

native helper 让 stdout、stderr 与从 AppContainer 输出目录回收的全部文件共享同一个 `OutputLimitBytes` 预算。预算耗尽会终止 Job Object 并给出 `limit-reached`；回收阶段即使部分文件已经保留，也会重新扫描宿主输出目录并把真实 `outputBytes`、`outputFiles` 写进终态收据。根进程退出后若 Job 中还有后代，helper 先终止后代并把运行记为失败，不会在子进程仍写输出时抢先标记成功。

生产上限是 wall time 24 小时、输出 64 MiB、内存为宿主可观察内存的一半且绝不超过 1 TiB；默认值仍是 60 秒、16 MiB、512 MiB。`wallTimeMs` 来自 native `Stopwatch`，不是轮询时间。每个 native supervisor 用 `control\\supervisor.lock` 持有完整生命周期，并在恢复 suspended worker 前持久化 `ProcessId` 和创建时间。崩溃恢复看到同一运行已有正的进程身份时绝不会重复启动；若锁已经释放且该身份不存在，会记为失败以等待上层处理，而非猜测性重试。

队列可先持久化 `preparationIdentity: { runId, cancelToken }`，再调用 `prepareIsolatedWindowsRun`。同一身份只会回收同一份已完成的 handle。`abandonIsolatedWindowsPreparation({ runRootDirectory, preparationIdentity })` 在还没有运行目录时也会写入 `abandoned` launch claim 和零字节取消收据；对已失败或已失去 owner 的 materialization，它只删除该 run 直属的 `runtime`、`input` 私有快照，并返回实际释放的 `diskBytes`。已有 launch claim 时拒绝删除并要求 reconcile。准备日志同时绑定 PID 与进程创建时间，避免 PID 重用时误回收活动副本。

已 launch 但尚未启动 worker 的取消请求是 `{ version, runId, configBindingHash, cancelTokenHash }`。native supervisor 取得 `supervisor.lock` 后，先验证这个请求、launch claim、control/run 路径和不读取快照字节即可重算的配置绑定；匹配时直接写入 `cancelled`、`ProcessId=0`、`wallTimeMs=0`、`AppContainerCleanup=not-started`。因此大 venv 的逐文件重哈希不会拖住已持久化的 pre-launch cancellation。取消在重哈希中到达时也会停止验证；已恢复运行的 worker 继续由 Job Object 轮询该同一绑定请求并终止。

初始日志先在随机 staging 目录中完整写入、同步并以 hard-link 无覆盖发布，随后才原子改名为 `run-<runId>`。因此 canonical run 目录一旦可见就一定有可解析的身份日志；进程在 staging 中断只留下不占用该 identity 的 staging 目录，重试或取消仍可发布同一 identity 的正常记录。`launch.claim` 和取消请求使用同样的完整临时文件加无覆盖发布，不会把零字节或截断 JSON 当成竞争赢家。

AppContainer 只有零 capability；runtime、input 和环境库是其私有只读副本，只有其私有 output 目录可写。无全局 ACL、R/Python 安装或网络例外。AppContainer profile 已经按 run 唯一，workspace 使用短子目录以避免深层 venv 包路径触发旧 .NET Framework 的 260 字符复制上限。

## 当前范围与缺口

- Python 的 venv `site-packages` 按路径直接加入 `PYTHONPATH` 并以 `-S` 执行，普通纯 Python 和已冻结的扩展包可用；依赖 `.pth` 的激活副作用没有被执行。需要此类包时，应在后续受审工作中实现被显式描述、同样可哈希的启动规则。
- `Library\\bin` 已冻结并加入私有 PATH，但任意第三方扩展的 DLL 依赖仍必须由实际 AppContainer 夹具验证；不能从已安装清单推断兼容。
- R 外部库默认不是“全部用户库”。UI 必须明确选择包名；描述符冻结已安装依赖闭包后才可执行。
- 环境创建与发现不做依赖安装。任何联网安装、升级、降级或删除需要单独的用户同意和之后的可验证 apply 流程。
