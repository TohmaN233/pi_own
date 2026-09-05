# Harness 验收清单：备课优先

以 main 上的真实合并提交为准。本文件列出验收步骤，不是已经通过的人工测试记录。
不要把文件存在或勾选框当成 CI 证据。旧聊天中的完成声明不能覆盖仓库实际状态。

记录：日期、OS、Node、`git rev-parse HEAD`、Provider/Model、失败日志（去掉密钥）。
结果：PASS / FAIL / BLOCKED（依赖缺失）/ NOT RUN。

## X：先完成一节课

- [ ] 更新 main；按 docs/COURSE_BUILDER.md 启动，打开普通 Pi 会话。
- [ ] 点击“备课”；真实 Mode Pack 生效，资源清单包含 course-builder 插件、固定 Skill/workflow。
- [ ] 工具中只有专用 course_builder，没有因备课而开放任意 shell/write/edit。
- [ ] 创建项目，编辑学期容量、目标、受众、语言及 Beamer 配置，刷新后仍存在。
- [ ] 导入旧 PPTX，抽查真实页序、文本及备注；不要求母版/动画/图片语义复刻。
- [ ] 导入 PDF、TeX/Markdown；文件原文和 Hash 可追溯。坏批次不能留下部分材料。
- [ ] “分析资料”会调用真实 Agent，保存主题链、重复、跳步、符号不一致和练习机会。
- [ ] 生成学期计划，覆盖课次和目标，标明资料来源与教学设计理由。
- [ ] 未批准时不能保存下游正式单课计划；Agent 自行 approve/accept 被拒绝。
- [ ] 教师要求修改后生成新草案；旧 revision 操作被拒绝。批准正确学期计划。
- [ ] 生成第一课：时间、目标、学生动作、worked example、理解检查和资料关联完整。
- [ ] 教师批准单课计划后生成独立 Beamer 源码；用户模板约束优先。
- [ ] 默认编译禁用；本地明确设置 PI_COURSE_BUILDER_TRUSTED_TEX=1 后才启用。
- [ ] 安装 XeLaTeX 后得到真实 PDF、日志、退出码与 Hash 回执。缺编译器时明确 BLOCKED。
- [ ] 源码/日志审查指出引用、溢出等问题；不能声称它已经看过页面截图。
- [ ] 下载 PDF 人工逐页看字号、公式、框内溢出、图表与教学内容，勾选后接受当前版本。
- [ ] 改动祖先计划或 Deck 后，旧编译/审批不能用来接受新版。
- [ ] 关闭服务并重启；重新打开原 Pi 会话再进备课，恢复同一项目与审批状态。
- [ ] 切回 General 后 Course Builder 专用资源退出；再进入可恢复。

## A：现有 Mode Pack / 学习底座

- [ ] General → Coding → Creative 的实际工具、Skill、Prompt 与生效清单一致。
- [ ] 自定义包 Fork/编辑产生新 revision，两个编辑窗口不会静默覆盖。
- [ ] Required 资源丢失时失败，不假激活；未固定模型时保留当前会话模型。
- [ ] 两个课程分别开会话，A 不能检索/引用 B 的私有来源。
- [ ] Tutor 引用可点击、Reason 可见；资料不足与推导明确标记。
- [ ] Practice 未尝试不可读取私有题解；一次性 Capability 不能跨会话/课程重放。
- [ ] Teach-back 的当前指导可用，但完整自由文本状态机仍不是本次完成项。
- [ ] Timeline 与 Pi JSONL 分工明确，重启后正式学习事件不丢失。
- [ ] Fork/恢复继承正确 Snapshot，不静默更换角色、课程或工具。

## 本版本不作为失败项反复尝试

可编辑 PPTX 输出；母版/动画复刻；完整 TeX OS 沙箱；自动截图批准；任意 Python/R
可视化执行；自动把 VisualHost 产物插入某页；完整教师/学生发行包物理拆分；正式
多模型教学质量 benchmark。当前可视化只生成独立的固定 Renderer 产物。

## 失败报告

测试编号；commit；预置条件；逐步操作；预期/实际；完整错误；截图；重启是否复现。
跨课程泄漏、未授权私有答案或错误 Runtime 恢复：立即停止用真实私有资料，保留日志。
