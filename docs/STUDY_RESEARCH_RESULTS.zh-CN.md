# Study / Research 结果分析

`ResearchResult` 是分析记录，不是“运行成功”的别名。它只能从两种不可变来源创建：

- `terminal-run`：Harness 在同一 SQLite 数据库中拼接已冻结的 Research cell run、Host 终态任务、队列收据和公开协调器输出。`succeeded`、`failed`、`cancelled`、`limit-reached` 都会保留；未终态、伪造代码/参数/输入哈希或队列不一致会拒绝保存。
- `theory-plan`：当前精确的 `TheoryPlan` 版本。它没有也不会创建合成执行任务；冻结计划本身是理论分析的审查材料。

草稿仅能在显式 Research 阶段创建或编辑，并同时使用 phase、project 和 result revision 的 CAS。编辑会保存旧版本历史，原有审查不会自动覆盖新版本。Study 阶段可以读取历史和发起“理解本次实验”的前台 Pi 提示，但不能写入或确认。

结果和终态学习条目按项目共享。不同对话可以查看并理解同一项目的冻结运行和分析；只有冻结运行所属对话才能把该运行作为新的 terminal-run 分析来源保存，因此查看共享证据不会扩大执行或写入权限。

正式确认是独立的浏览器用户事件。它要求结果版本有明确主张和限制，且该**精确版本/哈希**存在通过的独立审查、没有失败或未解决的审查。数值检查与进程终态可以作为证据，不能代替正式主张、独立审查或用户确认。Pi 的 `study_results` 工具只有 `state` 与 `save_analysis`，没有确认或发布动作。

理论和完整 terminal-run 结果允许独立审查使用其冻结计划或代码/输出作为自包含材料，因此其 review packet 可以有空 source evidence。Host 只接受空 evidence 用于该精确的 `result` target；对应报告还必须没有 checkpoints、notes 或知识图谱写入。任何普通阅读、来源审查或旧 legacy execution 仍需真实的、定位到持久 source chunk 的证据。

## Pi Web 集成契约

- 注册 `apps/pi-web/lib/study-research-results-extension.ts` 仅到 Research 的工具清单。
- 在结果区域挂载 `StudyResearchResults`，传入 session、当前 phase/revision、project revision、刷新回调和现有前台 Pi 消息派发器。
- `onLearn` 接收 `{ prompt, resultId?, taskId? }`。直接把 `prompt` 作为用户可见的前台 Pi 提示，不切换模式、不启动测验，也不创建新运行。
- `/api/study-research/results` 的 `POST` 使用 same-origin 浏览器 mutation gate。`confirm` 在服务端生成用户事件 ID；不要为模型调用提供这个路由或等价能力。
