# 可定制学习图形的渲染边界

`apps/pi-web/components/study/StudyVisualization.tsx` 为学习和教学提供同一渲染组件。当前只是待接入的组件，尚未完成插件注册、Host 归属、保存与正式教学发布。

代码是接受 `inputs` 的 JavaScript 函数体，可自行计算路径、曲线、带区域等，返回 `{ elements, summary }`。`elements` 允许 `path/circle/ellipse/line/rect/polyline/polygon/text` 及明确的几何和配色属性，坐标系为 800×500。它不是固定统计模板；任意计算结果必须经过图元校验，不能直接插入 HTML 或 SVG 源码。

外层 iframe 只授予 `allow-scripts`，不授予同源、导航、表单或弹窗权限。CSP 禁止网络、图片和外部脚本；生成代码只在子 Worker 中运行，收不到主页面、DOM、凭据或 Host 调用能力。每次计算 3 秒到限终止；图元、输出、输入和源码均有数量／大小边界。Worker 时限不等于进程级内存硬限额，不能将此组件的防挂起措施称为 OS 资源沙箱。

主页面只接受当前 iframe window、opaque origin、随机 channel 对应的显示状态。消息不能写 Host，不能登记验证通过，不能批准成果。源码／参数／revision 变化会更换 channel 和 iframe。`validationLabel` 必须来自实际 Host 验证状态，不能由生成代码提供。

2026-09-12 的真实 Edge headless 验证：

```powershell
$env:PI_PLAYWRIGHT_MODULE = '<本机已安装 playwright 模块目录>'
node scripts/study-visual-sandbox-smoke.mjs
```

脚本位于 `apps/pi-web/scripts`，在 Pi Web 目录运行，不需要 dev server、生产数据库或模型。已证明：实际 SVG 像素对象建立、修改输入后坐标更新、非法图元被拒绝、外部 fetch 与主页面访问失败、死循环被终止、伪造窗口／origin 消息被拒绝，未发出 HTTP 请求。

以上是渲染与隔离证据，不是具体论文的数学验证。独立 oracle、边界／退化例、真实用户控件交互、版本绑定审查、两种 owner 的实际插件加载和教学门槛仍待接通与验收。
