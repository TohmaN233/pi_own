# Study & Research 执行切片

本切片把 Research 计划、用户批准范围、原生代码单元运行和结果历史分开保存。它复用同一个 Learning Harness SQLite、全局执行队列、Windows 原生 R/Python adapter 和不可变代码单元快照；没有第二套执行器或产品数据库。

## 用户动作与边界

`/api/study-research/research` 只接受受信任浏览器请求。它提供用户创建/修订计划、批准或撤销范围、提交或取消运行、提升学习运行和记录修复的动作。Pi 工具不调用这个路由，也不会收到用户事件能力。

批准范围创建 Host 的 Research grant，并在同一 SQLite 事务中保存更窄的 `ResearchExecutionScope`。范围固定：

- 当前计划 ID、revision、semantic digest 与当前来源版本；
- R/Python 允许集合和可读取的同项目来源版本；
- 每次 CPU、内存、墙钟和输出上限；
- 累计次数、墙钟和输出配额，以及同一到期时间；
- 用户写下的实现改动边界。

范围不包含模型 token 或费用预算。新的 scope 总是产生新的 Host grant，因此不会改变已经物化的 grant 级累计配额。撤销范围撤销对应 grant；未启动任务会在队列重新准入时失败为可见的 `needs-input`，已经启动的原生进程仍可在同项目历史中查看或明确取消。

## 计划与执行

四种计划由 Host 的 discriminated contract 校验：Theory、Smoke、Formal 和 Exploration。Theory 没有数据集、指标或随机种子必填项。正式计划的科学字段变更会改变 semantic digest 和 revision，旧 grant/scope 因而不能用于新运行；笔记不在 digest 中，不会误撤销范围。

每个 Research 代码单元运行都通过 `LearningHarness.admitStudyCellExecution`：队列 reservation、Host task、不可变 cell revision、实际代码/参数/输入字节/环境 payload 和 Research metadata 在同一 `BEGIN IMMEDIATE` 事务内提交。范围校验再次检查来源、语言、单次资源、grant、到期时间和变更说明。没有路径或 Agent 提供的 shell/read/write 参数进入该通道。

Smoke 计划可选择受限学习准入，不需要每条命令重复批准。它仍在同一事务中保存 `smoke-learning` 元数据，绑定计划 revision、cell snapshot 和变更说明；原 Host task 保持 `learning` 授权。Theory、Formal 和 Exploration 必须使用有效 scope。

## 历史、提升和修复

浏览器返回的范围、运行、提升和修复 DTO 不含来源路径、私有 coordinator handle、trusted runner identity 或 `userEventId`。状态和取消始终按项目读取，不依赖页面是否还打开。

提升一个学习运行会新建独立 Research plan，并保存原 task/cell snapshot 的 provenance。它绝不把原 learning task 重标记为 Research。修复记录只能引用终态的 cell run 和新 code-cell revision，必须写明原因；旧失败运行保持不变，系统不会自动声称任意两版代码语义等价。

## 证据

- `node --experimental-strip-types --test scripts/study-research-execution.test.mjs` 覆盖真实共享 SQLite 的 scope grant、原子 payload、重放、错会话/伪造/过期/撤销拒绝和 learning-run promotion。
- `node --experimental-strip-types --test lib/research-execution-service.test.mjs`（在 `apps/pi-web`）覆盖 browser-only route 的计划、scope、撤销、公共响应脱敏和无 provider 调用。
- Host、learning admission 和 cell admission 的既有定向测试继续覆盖计划语义、来源更新、注释不撤销和队列累计配额。
