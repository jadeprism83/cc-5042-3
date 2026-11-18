# 渲染契约：颜色空间、混合与边缘

本文件是 `web/js/renderer.js` 与 `shared/shaders.mjs` 所实现约定的说明。任何替换渲染
路径的实现都必须满足同样的条款，否则界面中“距离场”和“实际渲染”会出现两套口径。

## 1. 图集纹理

- 单通道 **R8**，内部格式 `R8`，格式 `RED`，类型 `UNSIGNED_BYTE`。
- 内容是有符号距离，**不是颜色**，因此**不进行 sRGB 解码**。绝不能用
  `SRGB8_ALPHA8` 或 `SRGB8` 上传。
- 过滤：`LINEAR` 用于文字绘制；检查器的原始数值/阈值视图用 `NEAREST`。
- 环绕：`CLAMP_TO_EDGE`。

## 2. 数值约定

| 字节 | 含义 |
|---|---|
| 128 | 距离 0（字形边缘） |
| 129..255 | 内部，最大 `+rangeTexels` |
| 0..127 | 外部，最小 `−rangeTexels` |

解码在着色器内：`dTexels = ((b·255 − 128) / 127) · rangeTexels`；
`dPx = dTexels / texelsPerEm · pxPerEm`。`rangeTexels`、`texelsPerEm` 与
`pxPerEm` 都是每实例属性，不是全局常量。

## 3. 画布与混合

- WebGL2 上下文：`alpha:false`、`premultipliedAlpha:false`、`antialias:false`。
- 画布由浏览器作为 **sRGB 显示表面**合成。
- 文字颜色（`a_color`）是 sRGB 分量，未转线性；覆盖度与之直接混合。
- 混合函数：`blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)`，
  **直通 alpha**，着色器输出不预乘。
- 这是覆盖度混合，不是光照混合，因此不引入线性光照语境。此点写死，避免下游
  再做一次色彩管理而双重校正。

## 4. 边缘

- 屏幕空间 AA 斜坡固定 **1 CSS 像素**（`u_edgeWidthPx`，按 DPR 缩放）。
  覆盖公式：`alpha = clamp(dPx / 1px + 0.5, 0, 1)`。
- 所有字号共用同一阈值与同一公式。“边缘一致”指此点；它不意味着与轮廓光栅化
  逐像素相同。大字号时每图集 texel 被拉伸，场的梯度被双线性插值平滑，尖角会轻微
  圆化。实际偏差见 `docs/report/REPORT.md` 与 `metrics.json`。
- 细笔画的支持边界由 `texelsPerEm` 与 `rangeTexels` 共同决定。当前 64 texel/em、
  ±10 texel；报告记录了细体（ExtraLight）在各字号下的 IoU 与 EdgeMAE。

## 5. 图块与相邻污染

- 图块四周有 `padTexels` 像素空白，且构建时强制 `padTexels > rangeTexels`。
  边框因此饱和为“远在外侧”。
- 双线性采样越出图块时只会得到饱和值，不可能读到邻字。
- 片元着色器再检查 `v_uv` 是否落在本字形图块矩形内，越界即 `discard`。

## 6. 实例数据

每实例 17 个 float：`rect(4) + uvrect(4) + rgba(4) + screen(2) + glyph(3)`，
其中 `glyph = (rangeTexels, texelsPerEm, pxPerEm)`。`uvrect` 是图集中的 texel 矩形，
`rect` 是屏幕 CSS 像素矩形。二者由同一清单条目给出，保证图形范围与屏幕位置一致。

## 7. 编辑器回写

矢量编辑器只能改变图块**内容**，不能改变图块在图集中的位置或尺寸。回写使用
`texSubImage2D` 覆盖原矩形，因此所有既有实例与图集布局保持有效。若编辑后的墨迹
（含描边偏移）侵入 `padTexels`，内核抛出 `PAD_BREACH`，界面显示错误并拒绝提交。

描边是精确的有符号距离偏移：正值为膨胀，负值为侵蚀。侵蚀超过字形的最大内接半径
时，图块里不再有任何距离为正的像素，结果是空字形。这不是渲染失败，内核照常返回；
编辑器用内核给出的 `stats.maxDistanceEm − bias` 说明这一点，而不是留一块无解释的黑区。
