# pi-own

**开发中。目前主要用于备课。**

pi-own 基于 Pi 与 Pi Web，探索一个在本地保存资料、课程资产和对话的个人 Agent 工作台。当前开发重点是教师备课：从资料与学期安排，到单课教案、Assignment、可视化和 Beamer 课件的生成、修改与审阅。

项目仍在迭代，功能和数据结构可能变化；尚不承诺稳定版本或生成内容完全正确。

## 当前能力

- 以课程／项目组织多个对话，共享默认模型、提示词和 Skills，并允许会话单独调整。
- 链接本地资料文件夹、按需读取资料；支持聊天附件，课程和 Assignment 资料分开管理。
- 编写和审阅学期计划、单课教案、作业及课件；已有资产按版本继续修改。
- 编辑 TeX、预览 PDF、执行编译和确定性检查，以及人工验收与取消验收。
- 为生产请求保存交付要求，未完成时自动续跑，并明确显示阻碍；不会将保存或编译成功等同于内容完整。
- 在项目的 `skills/` 中管理技能，由模式组合启用，用户可调整。

## 本地运行与文档

环境需要 Node.js 和 npm；PDF 文本提取需要 `pdftotext`，Beamer 编译需要可用的 XeLaTeX。模型凭据由使用者在本机配置。

- [Windows 本地运行](docs/LOCAL_TESTING.zh-CN.md)
- [备课工作流](docs/COURSE_BUILDER.md)
- [功能测试清单](docs/HARNESS_ACCEPTANCE_CHECKLIST.zh-CN.md)
- [技能参考与适配记录](docs/SKILL_PARITY_AUDIT_2026-09-05.zh-CN.md)

仓库不提供个人凭据、聊天记录、课程资料或生成课件。运行数据与附件保存在本地，不应提交到 Git。

## Credits · 基础项目与参考

- [Pi / earendil-works/pi](https://github.com/earendil-works/pi)：Agent runtime、工具调用、多模型接入及会话基础。本仓库保留相关源码与许可证。
- [agegr/pi-web](https://github.com/agegr/pi-web)：Web 对话界面基础。当前集成基线为 v0.8.11；[来源清单](docs/pi-web-upstream-manifest.json)记录了上游版本。
- [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)：教学技能、显式加载技能、目标与评估对齐、复述诊断、来源审查及教学交互设计的重要参考。这里是面向 Pi Own 工具和工作流的适配，并非完整移植。见[署名与许可证](third_party/openmaic-skills/NOTICE.md)。
- [Noi1r/beamer-skill](https://github.com/Noi1r/beamer-skill)：参考其 Beamer 创建、编译、审查与修订流程。见[署名与许可证](third_party/noi1r-beamer-skill/NOTICE.md)。
- [Mozilla PDF.js](https://github.com/mozilla/pdf.js)：浏览器中的 PDF 预览。

## Credits · Skills

教学模式使用的本地适配技能位于 [`skills/`](skills/)：

| 本地技能 | 用途与主要参考 |
| --- | --- |
| `course-planning-beamer` | 备课和课件工作流；参考 OpenMAIC 与 beamer-skill |
| `lesson-blueprint` | 目标、理解证据与活动对齐；参考 `understanding-by-design` |
| `feynman-teach-back` | 解释、定位缺口和迁移检查；参考 `feynman-learning` |
| `learning-to-learn` | 主动回忆、预测和自我解释 |
| `curriculum-continuity` | 跨课衔接；参考 `curriculum-planner`、`spiral-curriculum` |
| `evidence-ledger` | 来源与事实核查；参考 `fact-check`、`deep-research` |
| `revision-discipline` | 在已有资产上最小修改并验证；参考 `pro-editing` |
| `learn-by-doing` | 操作、观察与反馈；参考 `deep-interactive`、`workshop-style` |
| `visual-explanation` | 服务于理解的可视化；参考交互与 `slide-craft` 方法 |
| `personal-skill-builder` | 可审阅的个人偏好技能；参考 `build-personal-skill` |

另收录可选技能：`pi-subagents`、`council-mode` 来自 [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)；`chrome-devtools` 来自 [github/awesome-copilot](https://github.com/github/awesome-copilot)；`gpt-image-2` 来自 [prime-skills/runcomfy-agent-skills](https://github.com/prime-skills/runcomfy-agent-skills)。收录不代表默认启用或已配置对应外部服务，来源记录保存在 `skills/.skills-lock.json`。

各第三方组件和技能遵循其各自许可证；本项目许可证见 [LICENSE](LICENSE)。
