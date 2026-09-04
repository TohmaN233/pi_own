# Pi Own Harness 验收清单（备课优先）

本清单用于验收 `main` 中已经合并的功能。每项填写 `PASS`、`FAIL`、`BLOCKED` 或 `NOT IMPLEMENTED`，失败时记录 Session ID、CourseVersion ID、Resource Snapshot ID、浏览器控制台和服务端日志。不要把 API Key、Cookie、私有答案或完整私有课程资料提交到公开 Issue。

## 0. 环境记录

- 测试日期：
- 操作系统：
- `git rev-parse HEAD`：
- `node --version`：
- 浏览器：
- Provider / Model：
- `PI_LEARNING_HARNESS_DIR`：
- `PI_CODING_AGENT_DIR`：
- `PI_PDFTOTEXT_PATH`：
- `PI_XELATEX_PATH`：

严重级别：S0 表示跨课程泄漏、私有答案提前泄漏、数据丢失或显示的 Mode Pack 与实际 Runtime 不一致；S1 表示核心流程无法完成；S2 表示 UI、诊断或易用性问题。

## 1. 启动

- [ ] `start-learning-harness.ps1 -CheckOnly` 能核验 Node、依赖和 PDF 提取器。
- [ ] 正常启动后打开 `http://127.0.0.1:30141`。
- [ ] 端口被其他服务占用时明确拒绝，不误连错误服务。
- [ ] 自定义 Harness 与 Pi agent 数据目录得到遵守。
- [ ] 重启后已提交状态恢复。

## 2. Mode Pack

- [ ] 普通会话可在 General、Coding、Creative 间切换。
- [ ] 切换后 Snapshot Inspector 中 Prompt、Skill、Plugin、Workflow 和 Tool 与实际 Runtime 一致。
- [ ] 未选资源退出 Runtime，而非只靠提示词劝阻。
- [ ] Required 资源缺失或内容 Hash 改变时 fail closed。
- [ ] 未固定模型的 Mode Pack 保留原会话模型。
- [ ] 重启与 Fork 继承正确 Binding，不采用父 Session ID。
- [ ] JSONL 已提交新 Binding 后，失败路径不会恢复旧 Runtime。
- [ ] 自定义 `custom.*` 包使用不可变 revision；过期 writer 与 stale delete 被拒绝。

## 3. 课程与教学模式

- [ ] 导入 Markdown、TXT、PDF、Notebook、代码或 ZIP 后生成不可变 CourseVersion。
- [ ] 课程 A 会话不能检索或引用课程 B 的 Span。
- [ ] Tutor 回答中的 direct、synthesis、derived、computed、external、insufficient 范围和 Reason 可见。
- [ ] 未通过结构化发布门的课程回答不会作为正常答案流出。
- [ ] Practice 必须先记录有意义尝试，再反馈、提示或授予一次性答案 Capability。
- [ ] Capability 不能跨 Session、课程或到期边界重放。
- [ ] Teach-back 先获取学习者解释，再定位最小缺口和迁移任务。
- [ ] Timeline 跨同一课程的多个会话持久存在，Compaction 不会删除正式事件。

# 备课优先验收

## 4. Course Builder 入口与 Mode Pack

- [ ] 普通 Pi 会话可以打开 Course Builder 工作区。
- [ ] 打开工作区后激活 `course-builder` Mode Pack，而非只改变页面名称。
- [ ] Snapshot 中包含课程规划、Beamer、来源核查、最小修订和可视化资源。
- [ ] Agent 侧只有专用 Course Builder 工具，没有绕过审批的通用写入或任意 shell 权限。
- [ ] Course Builder Session 与项目 Binding 在重启后恢复。

## 5. 项目与材料导入

建立一个真实但可公开测试的小课程项目。

- [ ] 创建项目时记录周数、每周课次、单课时长、学生层次、语言、课程目标和 Beamer Profile。
- [ ] 导入 PPTX 后按页提取文字与 Speaker Notes，并保存原始文件 Hash。
- [ ] 导入 PDF、TeX、Markdown、TXT 和支持的素材文件。
- [ ] PPTX ZIP 条目数、单 XML 大小、总文本量和输入大小预算生效。
- [ ] 路径穿越、重复路径、超大输入和不支持格式被拒绝。
- [ ] 材料修改产生新 revision 或新内容身份，不静默覆盖已批准计划的来源。
- [ ] PPTX 导入明确标注为语义提取；不冒充完整保留母版、动画和精确布局。

## 6. 材料分析

要求 Agent 审计全部导入材料。

- [ ] 输出核心知识链、先备关系、重复、跳步、缺失、术语和符号不一致。
- [ ] 标出每项判断使用的材料来源。
- [ ] 列出适合例题、Practice、Teach-back 和可视化的位置。
- [ ] 资料不足处明确说明，不自动补成课程原文。
- [ ] 修改分析产生新 revision，并使依赖旧分析的未批准计划失效或要求更新。

## 7. Semester Plan

- [ ] 计划课次数严格匹配周数 × 每周课次，或明确记录假期／考试周例外。
- [ ] 每节包含学习目标、主题、先备、来源、活动、理解证据、作业／评价、重访和可视化机会。
- [ ] 先备主题先于依赖主题。
- [ ] 螺旋重访至少增加复杂度、关系、抽象、形式化、表征、迁移或边界之一。
- [ ] Agent 不能在草案中写入 `approved`、`approvedAt`、`reviewer` 等审批字段。
- [ ] 只有教师 UI 可以批准或要求修改。
- [ ] 过期 revision 的审批被拒绝。
- [ ] 新 Semester Plan revision 使依赖旧计划的 Lesson Plan 明确变旧。

## 8. 第一节 Lesson Plan

- [ ] 从已批准 Semester Plan 生成第一节课。
- [ ] 总时间与课程时长一致或明确保留缓冲。
- [ ] 包含可观察学习目标、先备知识、常见误解、教师动作、学生动作和理解检查。
- [ ] 定义附近有 worked example、反例或边界。
- [ ] 主动回忆、预测或自我解释不是装饰性文字，而是具体学生动作。
- [ ] 可视化说明学生观察什么、观察支持什么结论。
- [ ] Agent 不能自行批准 Lesson Plan。
- [ ] Lesson Plan 更新后，旧 Deck 不能继续编译、审查或接受。

## 9. Beamer Deck

- [ ] 从已批准 Lesson Plan 先生成 frame-by-frame 结构，再生成 `.tex`。
- [ ] 用户自定义 preamble、theme、作者、机构、语言、比例、字号、notes、overlay、references 和 backup policy 得到尊重。
- [ ] `.tex` 是内容、公式、符号、引用和页序权威。
- [ ] Deck source 使用不可变 revision；修改后旧 Compile Receipt 失效。
- [ ] 危险 TeX primitive、路径越界和 shell escape 被拒绝。
- [ ] 编译命令包含 `-no-shell-escape`，并受时间、输出和日志预算约束。
- [ ] 编译产生 Source、PDF、日志和 Receipt Hash。
- [ ] 失败编译不会发布或残留一个可被误认作当前成功产物的半成品 PDF。
- [ ] 未解析引用、undefined control sequence、overfull box 和页数被报告。
- [ ] 编译成功不自动等于视觉、教学或教师接受通过。

## 10. 视觉与教学审查

- [ ] 逐页检查文字、公式、表格、图片、Block 内部溢出和投影距离可读性。
- [ ] 检查符号在使用前定义、定义附近有例子、理论页之间有认知节奏。
- [ ] 检查颜色不是唯一编码，并满足足够对比度。
- [ ] 可视化有确定性 Spec、Data、Trace、Artifact Hash 和当前 revision 验证。
- [ ] Review 与最终 Acceptance 是不同回执。
- [ ] 只有当前 Lesson Plan、当前 Deck、当前成功 Compile Receipt 和当前 Review 可以被接受。
- [ ] 教师拒绝后保留上一个已接受版本，不产生半提交状态。

## 11. 完整恢复与并发

- [ ] 浏览器刷新后项目、材料、计划、Deck 和回执仍存在。
- [ ] 服务进程重启后恢复相同当前 revision。
- [ ] 两窗口编辑同一对象时，过期 writer 被拒绝。
- [ ] 数据库写失败后不会继续使用未提交内存状态。
- [ ] Fork 的 Pi 会话不会错误取得另一项目 Binding。
- [ ] Course Builder 与学生课程会话不能通过硬切换混用角色和私有资源。

## 12. 仍需如实标记的边界

对每项填写当前测试版本的真实状态：

- [ ] PPTX 母版、动画、SmartArt、原生图表和精确布局完整保真。
- [ ] 自动生成可编辑 PPTX。
- [ ] 操作系统／容器级 TeX 沙箱。
- [ ] 自动逐页浏览器截图和视觉回归。
- [ ] 任意数学代码执行沙箱。
- [ ] Teacher 与 Student 构建物理拆分及真实产物递归泄漏扫描。

这些能力未实现时必须填写 `NOT IMPLEMENTED`，不能以普通文件解析、`-no-shell-escape`、静态 HTML 或对象级扫描冒充。

## 13. 最终判定

- [ ] 核心 Mode Pack：PASS
- [ ] 课程隔离与 Grounding：PASS
- [ ] Practice 答案门：PASS
- [ ] Course Builder 项目与导入：PASS
- [ ] Semester Plan 审批链：PASS
- [ ] Lesson Plan 审批链：PASS
- [ ] Beamer 生成与编译：PASS
- [ ] Review 与 Acceptance：PASS
- [ ] 重启与并发：PASS
- [ ] 没有 S0

结论：

- [ ] 可用于真实备课试运行。
- [ ] 可用但需先修 S1。
- [ ] 只适合测试资料，不应用于私有真实课程。
- [ ] 出现 S0，立即停止并保存最小复现证据。

## 失败报告模板

```markdown
## [CHECK-ID] 标题

- Severity: S0 / S1 / S2
- Commit:
- OS / browser / Node:
- Provider / model:
- Session ID:
- Project ID / CourseVersion ID:
- Snapshot ID / revision:

### Preconditions

### Exact steps
1.
2.
3.

### Expected

### Actual

### Complete error text

### Evidence
- Screenshot:
- Browser console:
- Server log:
- Relevant JSONL path:
- Harness database path:

### Reproducibility
- Always / intermittent / once
- Reproduced after restart: yes / no
- Reproduced in a fresh data directory: yes / no
```
