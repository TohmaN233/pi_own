# Study / Research R 与 Python 包环境

`/api/study-research/environment` 提供一个只给同源浏览器使用的包计划界面。它不是通用终端、任意 URL 下载器或模型工具入口。`POST` 必须通过 `isStudyBrowserMutation`；模型、renderer 消息和普通 API 调用都不能制造安装同意。

Python 只解析和安装项目目录里的 `.study-python-venv`，并要求它已经由 Python cell 创建。R 只使用 R 已存在的普通用户库路径，不请求管理员权限。开发和回归测试绝不使用该 R 用户库；测试创建的 venv、wheel 和临时目录都在 `.artifacts/study-research/environment-packages` 或 `environment-ownership` 内。

## 冻结计划与同意

浏览器提交包名（和可选精确版本）后，受信任服务读取当前实际清单，并调用各语言自己的固定解析器：

- Python 使用隔离的 `pip install --dry-run --report`，只接受 wheel（`--only-binary=:all:`）并把索引固定为 `https://pypi.org/simple`。报告中的实际 wheel 必须来自 `files.pythonhosted.org`，并带 SHA-256。
- R 使用 `Rscript --vanilla --slave`，把 source 仓库固定为 `https://cloud.r-project.org`，读取 source `available.packages` 元数据、MD5 和递归 Depends/Imports/LinkingTo。显式 R 版本只有等于该固定 source 仓库当前版本时才可解析；不支持把 CRAN Archive 当作未受限下载器。回归用的本地 CRAN 样本仓库只能在隔离 R 用户库内传给受信任测试入口，浏览器没有这个参数。

计划保存完整的原始库存、库存哈希、所有直接和传递包的版本、源和源哈希。缺失包可以直接排队。任一已安装包升级或降级会把 `requiresExistingChangeConsent` 写进同一计划；安装请求必须携带该计划的版本和同源浏览器的勾选确认。计划、请求 id 和 session 绑定均由 Harness 的 SQLite 事务检查，不能重放为另一份计划或另一段会话。

执行前会再次比较库存哈希。执行后不会只检查请求的包：最终库存必须精确保留未批准包的名称、版本和位置，并且每一个批准包都必须有冻结版本。R 会保留跨库的同名包记录，并以用户库副本作为有效版本；更新用户库副本时仍会核对系统库中被遮蔽的旧副本未变。额外添加、删除或未批准变更都会使操作失败并保留可见诊断。

## 后台状态、锁和恢复

浏览器先持久化 `queued` 操作，再启动普通用户权限的独立 worker。worker 不读取 Pi phase、浏览器请求或会话运行时，只用 `projectId` 和 `workerId` 领取 SQLite 中的冻结操作。状态是 `queued`、`running`、`succeeded`、`failed` 或 `unknown`。

每个环境以语言、可执行文件和环境目录的稳定哈希加全局锁。相同 Python venv 或 R 用户库即使属于不同项目也不会并发安装。安装领取同一 SQLite 事务还会等待所有非终态 native execution job；执行领取则由队列的同一事务检查 package lock。因此首版采用保守全局暂停：任何活跃安装会暂停新 cell execution，任何活跃/准备中的 execution 会暂停新安装。

worker 在每个固定包管理器命令期间每 30 秒续租；每条命令最多 10 分钟、stdout/stderr 合计最多 1 MiB。变更库的命令不会由 worker 直接启动：隐藏的 Windows supervisor 先把安装器创建为 suspended，放入 `KILL_ON_JOB_CLOSE` Job，再持久化 supervisor 的 PID、精确 FILETIME 创建标识和可执行文件路径；只有记录成功才写 gate 并恢复安装器。超限、租约丢失或恢复取消都通过该精确身份打开 supervisor handle 并终止它，Job 随即关闭并清理完整后代树；不使用 `taskkill` 的 PID 树扫描。

若 worker 租约到期或在可能已运行安装器后失败，操作变为 `unknown`，锁保持，后续同环境请求显示需要人工处理而不会自动重试或并发写入。普通 `environmentPackageDrainState` 读取本身会事务性地把过期的 sole running 操作改为 `unknown`，不需要等另一 worker 来 claim。没有持久 supervisor 证据的 `unknown` 即使当前库存恰好等于初始库存也不能解锁；reconcile 必须先证明记录的 supervisor 已停止，再接受不可变初始库存或精确批准的最终库存。

claim 按创建顺序检查所有 queued 行，领取最早的可运行且未锁环境；未知的环境 A 只阻塞 A，不能饿死后面的可运行环境 B。`environmentPackageDrainState` 区分短暂等待的执行/安装锁和 `needsInput` 的 unknown 锁；worker 只有在没有 runnable 行时才因 `needsInput` 退出，因此会先 drain B 再报告 A 的人工处理。

## 已知解析边界

这不是完整的跨仓库依赖求解器。Python 拒绝 sdist，因此 preview 不会执行 sdist 的 build hook；只支持固定 PyPI index 的二进制 wheel。Python 包名按 PEP 503 归一化（大小写不敏感，`-`、`_`、`.` 等价），版本栏只接受一个精确版本，不能填写范围、URL 或 marker。R 只支持固定 CRAN source 元数据当前可见的版本，且需要 CRAN 发布 MD5。当前开发主机通过环境发现使用 `C:\Program Files\R\R-4.5.1\bin\Rscript.exe`（它不在 `PATH`）；回归以隔离临时 R 用户库验证实际 R 库存、跨库遮蔽和 no-op 最终验证，但不会对真实用户库进行 R 下载或安装。运行时发现失败会作为可见解析错误，而不是退回到别的解释器或静默跳过。
