# Study & Research 论文改稿

论文改稿只在 Research 阶段工作。它不是来源导入或普通笔记更新：用户先在同源浏览器页面选择已注册的 TeX 或 DOCX 来源，并写下明确的改稿请求；随后 Research Agent 才能使用该请求生成候选。没有浏览器请求，Agent 没有创建候选、确认写回、恢复或指定本地路径的能力。

## 候选与确认

候选要求每个操作精确匹配一次：

- “add” 在唯一锚点前或后新增文字；
- “replace” 替换唯一旧文字；
- “delete” 删除唯一旧文字。

重叠、重复匹配、跨越 TeX 数学环境、修改 OMML、已有 Word 追踪修订，或不能落在一个安全 Word 文本 run 内的操作都会失败。TeX 会等长屏蔽注释后再定位，因此不会改变原稿 offset；受保护范围包括 dollar 内联/展示数学、\\(...\\)、\\[...\\]、equation、align、alignat、flalign、gather 与 multline 环境。Word 的全部操作先针对同一份原始 XML 解析为不可重叠的位置图，候续操作不能命中前一操作生成的文字。失败不会退化为模糊搜索或重新排版。

TeX 候选加入私有预览宏：新增为绿色、改写为蓝色、删除为红色并有 “[deleted]” 标签。候选会加入 xcolor，正式确认版本不会带入这些宏或颜色。DOCX 候选仅修改 word/document.xml，使用显式普通 `w:r`：新增为绿色，改写显示为红色删除线旧文字和蓝色新文字，删除为红色删除线。它刻意不写 `w:ins`/`w:del`，因为 Word 默认的追踪修订视图会按用户全局设置覆盖这些节点的颜色；操作身份和理由由不可变 patch journal 保存，而不是依赖候选文件的 Word 修订元数据。所有其他 ZIP entry 都在重建后按解压字节核验不变。

确认是独立的同源浏览器动作。写回前会再次核对：

1. 当前 session 仍在 Research，且阶段版本未变化；
2. 项目中仍是同一来源 ID/hash；
3. 磁盘原稿仍等于用户请求时读取的精确字节；
4. 候选的私有原始备份和干净版本 hash 完整。

通过后，系统在 SQLite immediate transaction 中再次核对 Research 阶段和 patch revision，然后在源文件同目录创建 fsync 的 staging 文件。它先以唯一 claim 硬链接保留原始版本、移除公开文件名并在 staging 前和发布前两次核验 claim hash；正式稿只以硬链接发布到仍不存在的公开文件名，并复核刚发布路径的 hash。外部编辑器若在窗口内创建新文件会赢得冲突，系统保留其字节并失败，绝不会用 blind rename 覆盖它。已有可写文件句柄的进程仍可在公开文件名被移除后写入旧 claim inode：发布前的第二次 hash 核验会检测该类已观察到的写入，但文件系统不提供对这种句柄写入的通用 CAS，最终核验后的极小窗口不能承诺绝对检测或保留该写入。正式稿从原始备份重新生成，故不会把候选的颜色或删除线写进原稿。

## 恢复与崩溃

每个成功候选在 Harness 数据库旁的 manuscript-patches 私有目录保留原始字节副本。它与来源更新、实验输入和其他临时备份完全分离。恢复也使用 CAS：只有当当前文件仍精确等于该次确认的干净正式稿时才会替换为备份；之后的人工编辑会明确冲突，绝不覆盖。

生成候选先用 patch revision SQL CAS 将 preparing journal 与一次性 lease 落库，再持久化候选和原稿副本，最后 CAS 转为 draft。运行中的 lease 不会被 state 轮询误判为失败；其他进程只会在 lease 到期后把不完整 journal 标为失败。重启或异常后：

- 两份 hash 完整的 preparing 产物会恢复为 draft；
- 缺失或损坏产物会保留失败记录和诊断；
- draft 发现源字节已经等于干净正式稿时，恢复为已确认；
- confirmed 发现源字节已经等于原始备份时，恢复为已恢复；
- 其他字节差异只记录失败，系统不自动写文件。

确认后，来源读取清单仍代表确认前的来源版本。若还要继续以新稿作为 Study 来源，应通过现有来源更新流程重新读取并确认新版本，而不是把物理写回伪装成旧来源 hash。

## 接口

StudyManuscript 的组件接口为 sessionId、phase、phaseRevision、projectRevision、onChanged 和可选的 onAsk(prompt)。浏览器请求成功后才调用 onAsk，以便宿主把该 patch ID、目标相对路径和原请求派发到同一个原始 Pi 对话。页面显示不可变目标路径与每项操作的理由；failed/preparing 记录不会显示不可用的候选下载链接。

study_manuscript 只提供 state 与 draft。浏览器 route 提供 request、confirm、recover 和候选下载；所有写操作都要求既有的同源 Study mutation guard。

## 验证

运行 node --experimental-strip-types --test scripts/study-manuscript.test.mjs，以及 npx tsc --noEmit --pretty false -p apps/pi-web/tsconfig.json。

夹具会实际编译 TeX 候选，检查 TeX 颜色宏与干净正式稿，检查 DOCX 的显式绿/蓝/红删除线 run、OMML 和未相关 ZIP entry，并覆盖来源冲突、写入失败、确认/恢复期间的 journal 对账，以及已打开源文件句柄在发布边界写入 claim inode 的检测。DOCX 结构和 ZIP 内容验证之后，仍应在目标 Word 环境以只读方式渲染候选、正式稿和恢复稿，确认显式色彩未受本机修订显示设置影响。
