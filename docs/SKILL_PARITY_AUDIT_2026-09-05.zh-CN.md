# 教学与备课 Skill 完整度审计（2026-09-05）

## 结论

升级前确实发生了过度简化。九个教育 Skill 只有各两行内联摘要，没有物理 `SKILL.md`，Course Builder 只加载了一段压缩后的 Beamer 指导。资源标签存在时，即使正文被清空，Runtime 仍可能报告已加载。

本次将重复使用的教学决策拆成仓库内 Skill；将版本、审批、工具和发布边界继续留在 Host；将正文加载与 SHA-256、物理文件摘要和 Snapshot 一起验证。

## 对照结果

| Pi Own Skill | 上游参照 | 升级前缺失的关键行为 | 当前保留的行为 |
| --- | --- | --- | --- |
| `lesson-blueprint` | `understanding-by-design` | 目标→证据→活动、迁移任务、边界、质量门 | 逆向设计、目标/证据/活动对齐、先备与误区、时间与迁移检查 |
| `feynman-teach-back` | `feynman-learning` | 学习者解释 v1/v2、最小缺口、术语消解、类比边界、迁移、真实记录 | 完整对话循环；备课时只设计活动，不伪造学习者回答 |
| `learning-to-learn` | `learning-to-learn` | 概念目标与学习动作并行、策略选择、开场/过程/收束位置 | 按需使用回忆、预测、自我解释、反馈重试与迁移 |
| `curriculum-continuity` | `curriculum-planner`, `spiral-curriculum` | 读取实际完成内容、概念脊柱、重访合同、假螺旋检查 | 先备链、实际证据边界、七类递进、每次重访的任务与证据 |
| `evidence-ledger` | `fact-check`, `deep-research` | creation/review 区分、高影响 claim、来源台账、冲突规则 | 有界核查、Claim→来源→版本→冲突→结论；无搜索工具时明确未核验 |
| `revision-discipline` | `pro-editing` | 读取真实产物、操作选择、最小修改、读回/渲染、跨产物一致性 | revision 冲突重读、局部修订、编译/渲染证据与失败保持旧版本 |
| `learn-by-doing` | `deep-interactive`, `workshop-style` | 操作→观察→结论、尝试后反馈、活动合同 | 预测、操作、观察、解释、重试和迁移；删除强制控件轮换与虚构角色 |
| `personal-skill-builder` | `build-personal-skill` | 代表性历史、支持与反例、用户确认、审阅后保存 | 偏好假设、反证、可审阅 Skill；不静默修改活动模式 |
| `visual-explanation` | `deep-interactive`, `workshop-style`, `slide-craft` | 可视化与学习目标的因果联系、预测与解释、实际检查 | 固定 Schema、确定性数据/trace、预览、教学用途和人工视觉检查 |
| `course-planning-beamer` | `Noi1r/beamer-skill` 与以上教学 Skills | 材料优先、结构与时间、密度、TikZ、编译审查循环、审批边界 | 严格 Course Builder 合同、课程/Assignment 资料隔离、学期/单课/Assignment 审批、可视化、Beamer 编译与人工逐页验收 |

## 有意不照搬的内容

- OpenMAIC 的页面 DSL、Stage 角色、特定控件组合和连续控件轮换不适用于 Pi Own。
- `deep-research` 的固定搜索次数改为任务预算；Course Builder 没有搜索工具时不会假装联网。
- Noi1r Skill 的 SJTU、10pt、16:9、固定主题、强制参考页与 Backup 页默认值会覆盖教师配置，因此不采用。
- 上游通用 `Read/Write/Edit/Bash/Agent` 工具不能映射进只允许 `course_builder` 的模式。
- Skill 说明教学判断；版本、允许字段、审批、编译、发布和私有答案边界由 Host 强制执行。

## 加载和验证合同

```text
Required component
  → 物理 SKILL.md 必须存在且非空
  → catalog 固定完整文件内容 Hash
  → Pi ResourceLoader 必须报告相同路径
  → 激活时重新计算物理文件 SHA-256
  → immutable system prompt 必须包含完整正文与正文 SHA-256
  → 任一检查失败，候选 Runtime 不得成为活动模式
```

Optional Skill 缺失时编译器可以明确跳过。Course Builder 所依赖的教学蓝图、学习策略、课程连续性、证据、修订、做中学和可视化均为 Required；Teach-back 在备课中是已启用的条件性 Optional Skill，在独立 Teach-back 模式中仍为 Required。

## 分类和维护

`course-planning-beamer` 的主类是可重复的教学业务流程，视觉与运行时核验属于产品验证。其余 Skill 是单一教学决策模块，避免合并成一个无法按情境选择的巨大提示词。文件由仓库维护，任何内容变更都会改变 catalog、Snapshot 和正文 Hash。

上游冻结版本与 MIT 许可证见 `third_party/openmaic-skills/` 和 `third_party/noi1r-beamer-skill/`。
