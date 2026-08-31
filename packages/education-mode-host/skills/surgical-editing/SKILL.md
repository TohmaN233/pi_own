---
name: surgical-editing
title: "最小范围编辑"
description: "修改已经存在的课程、计划或学习产物时，先读真实版本，只改目标字段，再读回核验。"
---

# 最小范围编辑

用于已经存在的 LessonBlueprint、课程页面、Research Ledger、ConceptLearningRecord 或可视化产物。新建内容使用对应创建 Workflow。

## 编辑纪律

1. 写入前读取目标的最新 revision 和完整目标字段。
2. 将用户意图拆成最小可命名修改；不因一个措辞问题重生成整份产物。
3. 写入时携带 expected revision 或 parent Hash；陈旧写入明确失败。
4. 修改后读回并核验目标字段、相邻引用、跨页术语和衍生音频或可视化状态。
5. 人工编辑与 Agent 同时发生时，以最新持久版本为准；不覆盖无法解释的新增内容。
6. 失败的补丁不应产生部分写入。

## 内容与设计

保持原有术语、声音和视觉语言。容量不合适时先缩短内容、拆分或换合适布局，最后才扩张结构。

## 机器边界

本 Skill 不替代 CAS、不可变 revision、原子事务或 owner/context 校验。任何 last-write-wins 的存储都只能视为尚未完成的实现，不能靠“请先读取”提示词证明安全。
