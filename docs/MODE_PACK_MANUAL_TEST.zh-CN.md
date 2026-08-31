# Mode Pack 本地验证

本检查点在原有 Learning Harness 启动方式上增加 Mode Pack 定义、教育 Workflow 和确定性 Visual Worker。以下步骤不等同于完整浏览器 E2E，但可以核对当前已接入界面与持久化行为。

## 先运行确定性检查

在仓库根目录执行：

```powershell
node --experimental-strip-types --test scripts/mode-pack-*.test.mjs
```

应同时通过 Windows 与 Linux 兼容的 Parser、Registry、Workflow、Skill 加载、Visual Worker、Artifact 发布门和现有产品接线检查。

## 打开自定义入口

按原有方式启动 Pi Web，然后访问：

```text
http://127.0.0.1:30141/mode-packs
```

页面左侧列出内置与自定义 Mode Pack，右侧是版本化 JSON 编辑器。

1. 选择 `Education Tutor`，点击“复制为自定义 Mode Pack”。
2. 将 `id` 改成一个新的小写连字符 ID，例如 `my-statistics-tutor`。
3. 修改标题、描述或 `prompt.mode`；不要删除合同字段。
4. 点击“只校验”。这一步不写数据库。
5. 点击“资源预览”。它检查服务器声明的 Skill／插件／包／工具／Workflow，并明确说明这不是 Runtime 激活回执。
6. 点击“发布新版本”。刷新后应在左侧看到 revision 1。
7. 选择该自定义项，点击“编辑为下一版本”。页面应自动写入 revision 2 和父版本 `parentContentHash`；revision 1 保持可读取且不会被覆盖。

## 预期拒绝

以下修改应失败且不影响随后正常发布：

- 加入未知顶层字段；
- 复用已经存在的 revision；
- revision 2 使用错误父 Hash；
- 同一资源同时出现在 required 和 optional；
- 必需 Skill／插件／包／工具／Workflow 未安装；
- 跨站点 POST；
- 非 JSON 或超过请求预算的正文。

## Skill 加载

教育 Skill 位于：

```text
packages/education-mode-host/skills/<skill-id>/SKILL.md
```

加载器要求真实路径仍在 Skill 根目录内、frontmatter `name` 与目录 ID 相同、正文非空，并为每份文件生成 SHA-256 内容 Hash。Required Skill 丢失时 Mode Pack 不能准备；Optional Skill 丢失时只允许带明确降级清单继续。

## Workflow 恢复

确定性检查会创建 SQLite 数据库，执行以下流程并重新打开数据库：

- Practice：等待真实尝试 → 反馈 → 等待重试或一次性答案；
- Teach-back：等待第一版解释 → 最多两个缺口 → 等待修订 → 等待迁移；
- Learn-by-doing／Visual Lab：等待预测 → 已核验计算 → 等待观察 → 等待迁移。

重复 learner turn id、陈旧 revision、跨 session/course/mode Hash 重绑定和跳步均应拒绝。预期拒绝不应把 Registry 锁死；只有数据库写入或回滚等操作错误需要重开。

## Visual Worker

当前 Worker 只接受：

- `matrix-transform`；
- `algorithm-trace`。

它不接受任意 HTML、JavaScript、URL、动态 import、文件路径或 Shell 命令。验证包含输入、输出、步骤、超时、取消、结果 Hash、Receipt 和 draft→verified→published Artifact revision。

## 尚未作为本检查点完成的浏览器路径

- 将 `ModeRuntimeAdapter` 接到现有 Pi `AgentSession` 的真实替换点；
- 在现有 Snapshot Inspector 中显示激活回执；
- 模式切换期间的浏览器崩溃、重连、fork 和 late-SSE E2E；
- Teacher Studio 的物理学生／教师构建拆分；
- 其余三种 Visual Renderer 的 Worker／Receipt 接入。

在这些项目完成前，发布自定义 Mode Pack 表示“定义已经持久化”，不表示当前 Pi 会话已经切换。
