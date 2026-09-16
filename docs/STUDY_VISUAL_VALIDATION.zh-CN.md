# 可视化数值验证

`StudyVisualValidation` 为某一个已保存的可视化版本建立数值场景检查。它不批准教学内容、浏览器交互或研究结论；这些分别由浏览器控制测试和独立学术审查处理。

## 规格与来源

用户在浏览器中保存规格时，必须给出 ordinary、boundary、degenerate、interaction 四类用例，写明假设、独立期望值的推导或参考材料，并选择当前来源及稳定定位。规格冻结目标 `visualizationId/revision/contentHash`、代码哈希、输入哈希、渲染环境哈希、每个 case 的输入哈希和来源版本。来源或目标版本变化后，旧运行在当前目标上显示为 `stale`，不能用来认证新版本。

规格中的 `expected`、oracle material 和来源材料只保存在 Harness 的验证记录中。它们不会写入 Node subject 的冻结程序或参数。

## 执行与比较

开始操作在同一个 SQLite `BEGIN IMMEDIATE` 事务中完成：冻结规格快照、目标、subject 程序、Node 环境、队列任务、任务目标和请求幂等键，然后保存 coordinator payload。已有相同请求键只能重放原任务；不同内容复用请求键会失败。

`packages/study-execution-host/src/visual-validation-execution.ts` 生成 `.mjs` subject。它为每个 case 创建新的 `vm` context，只把该 case 的 inputs 和已保存可视化代码交给代码体。它输出一个有随机关联键、长度受限的场景回执。代码不具有主进程、数据库、预期值或 oracle 访问能力。

后台 Windows Node adapter 捕获隔离进程 stdout。Harness 只接受一条与冻结关联键和 case/input hash 完全匹配的回执，再调用纯函数 `compareVisualObservations` 比较实际 scene。缺回执、回执格式错误、输入 hash 不符、执行失败和不完整观察都不会产生通过结果。结果保存为 `passed`、`failed` 或 `inconclusive`；`stale` 表示历史结果不适用于当前目标或当前来源。

## 前端边界

路由只接受同源浏览器变更。没有“标记通过”接口，iframe `postMessage`、用户文本或 Agent 工具都不能写入 canonical result。界面展示每条观察路径的期望值、实际值和容差，并保留失败、不确定和失效证据。取消和后台重连使用当前会话范围，因此模式变化不会让已可见的队列任务失去控制。
