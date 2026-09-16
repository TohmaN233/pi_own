# Study Assignment 适配

Study 默认是论文理解工作区，不会自动出题，也不维护掌握分数、完成进度或跳转锁。用户在浏览器中明确填写学习目标并选择当前来源后，`/api/study-research/assignment` 的同源 POST 才会创建一个请求。请求冻结会话、Study/Research 阶段及其 revision、项目 revision 和每个来源的 `sourceId`/`sourceHash`/可选定位。来源变更或阶段/项目 revision 变化后，旧请求不能继续生成草稿。

Agent 只有 `study_assignment` 一个工具，动作是 `state`、`read-request` 和 `save-draft`。它只能读取已经存在的浏览器请求，或在观察到请求和当前阶段/项目 revision 后保存草稿；它不能创建请求、批准、评分、强制完成练习或切换阶段。保存使用请求 revision 与草稿 revision 的 CAS，失败会保留原来的持久化记录并返回冲突原因。

适配层复用 `CourseBuilderHost` 导出的 `parseAssignmentDraft` 与 `AssignmentDraft` 类型，只把它们作为结构校验和跨产品的字段契约使用，不调用 `CourseBuilderHost`，也不创建 `courseVersionId`、课程、课次、Lesson、Assignment 或伪造的会话绑定。字段映射如下：

| AssignmentDraft 字段 | Study 含义 |
| --- | --- |
| `overview` | 本次练习的整体说明 |
| `tasks` | 按顺序排列的问题 |
| `solutionNotes` | 与 `tasks` 一一对应的答案解释，仅由用户逐题展开查看 |
| `deliverables` | 可选的理解产物或讨论准备项 |
| `rubric` | 可选的自检提示；不是评分引擎或批准门槛 |
| `materialIds` | 明确映射为本次请求中选定的 Study `sourceId`，不是 Course Builder 的 material ID |

来源身份保存在独立的 `pi_study_assignment_origin` 表中，不能从草稿的 `materialIds` 反推或替换。请求与草稿记录保存在同一个 Learning Harness SQLite 数据库中；重启后通过 payload hash、项目、会话和 revision 校验恢复。Study 和 Research 都可以按要求使用这个适配器，Research 仍须由用户显式切换阶段。
