# 备课与学习 Workflow 迁移

备课使用一个主 Pi-CAW Workflow：`course-production`。教师选择生成内容或操作，Host 根据所选课程、课次或 Assignment 及已有资产确定产物和创建/修订操作。Host 决定任务 ID、选定资料、基线版本、保存、编译/执行与真实收据；模型只创作本次所需的内容。默认包由真实语义转换、确定性编译和独立审阅形成，再按精确提案 hash 本地发布，不手写图冒充转换。

| 生成内容 / 操作 | 使用的主 Workflow |
| --- | --- |
| 资料分析、学期计划、单课教案 | course-production |
| 新建或修改课件 TeX/PDF、教师讲稿 TeX/PDF | course-production |
| Assignment 题目计划、学生 TeX 与解答 Rmd | course-production |
| Rmd 实验、独立可交互 HTML | course-production |
| 一节课的资料检查点、单课草案至 PDF/Rmd | course-production |
| Study/Research 当前问题讲解 | study-explanation |

界面的「生成内容/操作」和各产物快捷按钮提交同一主流程的产物参数，不是需要逐个启用的独立 Workflow。额外要求随所选操作提交；对话中的附件入口与现有产物编辑器保留。旧版产物 Workflow 的历史任务仍可查看状态和取消，不改写它们的 Run 或 pins。

任务只接收选定作用域的资料窗口和冻结源文件。修订从已有资产开始，未改字段由 Host 保留；除非教师明确放弃，不能整份重新生成。Assignment 的资料与产物目录保持独立。编译失败保留源码、诊断和上次成功 PDF，未通过校验不得宣称完成。

主流程包含 11 种产物 × 创建/修订的 22 条条件路径。每次只启动一个 Author，随后由 Host 保存并编译/执行，成功后直接结束；不会另起 Main 复述交付，也不自动批准教师草稿。末尾编译器 scaffold 的机械修订通过原生编辑器发布并记录 `direct_editor_publication`，保留原始语义转换和独立审阅身份。调度验证以模拟内容覆盖全部分支、文件绑定和未选分支跳过，不把它当作新的教学质量或 token A/B 实验。

首次进入模式时，只安装不存在的默认 Workflow。已有自定义图、开关和模型绑定保留。Workflow 开关及节点模型由模式设置 / Pi-CAW Workbench 管理；模型来自 Pi 当前目录，公共包不包含个人账号配置。

模式设置中的「Workflow」和 Workbench 的「加入此模式组合」调整当前会话、当前 Pack 的组合。切换 Pack 时自动使用对应组合，再切回来保留该会话的选择。备课默认只加入 `course-production` 主流程，也可加入已安装的通用 Workflow；Coding 和自定义 Pack 从真实共享目录继承通用默认组合。Study/Research 的主流程是 `study-explanation`。全局停用的定义或插件仍不可启动。组合保存不重载对话，不改共享图、已保存的提示词或已有 Run 的 pins；不同会话分别保存偏好。

Study 与 Research 可以通过 study_workflow 提交当前问题，回答保存为新增学习记录，并在原对话呈现。旧 Tutor、Practice、Teach-back、VisualLab 默认开放 Workbench 与开关；其练习答案、评分和活动状态仍由原 Host 维护，不把这些权限转交给通用 Role。它们目前没有独立的新生产适配器，不声明 study_workflow 可用于它们。

被替代的三份备课 Skill 在替代 Workflow 通过 Ready 校验后移到 skill-backups/course-workflows/，完整原文与 hash 保存，退出自动发现目录。通用教学方法、练习安全边界、人工批准/撤销批准、资料获取和设置功能保留。转换源位于 docs/course-workflows/authoring 与 docs/study-workflows/authoring，不作为活动 Skill 自动加载。

质量与消耗的历史依据：W5S2 草案至 16 页 PDF/执行 Rmd 的实跑已完成；其单次 writer 用量为 103,523 total tokens、$0.1637068。该数据不是所有模型/产物的性能承诺，也不是与旧流程的受控 A/B。工作流定义的首次转换与独立审阅消耗另计，日常任务不重做转换。只做新链路必要的代表性验证，不增加逐项量化教学评分门槛。
