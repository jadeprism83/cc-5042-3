# 字形图集：图形入口与交付说明

本项目交付一条完整的生成与绘制链：**可分发字体 → 轮廓 → 有符号距离场 → R8 图集与清单
→ GPU 实例化绘制**。浏览器界面只消费图集清单，不做任何 `fillText`、DOM 文本或位图放大。
本文件列出图集的全部图形入口，供后续接入或审阅。

## 1. 入口总览

| 层 | 入口 | 作用 |
|---|---|---|
| 字体与轮廓 | `shared/fontface.mjs` → `getFont` / `glyphContours` / `shapeRun` | 解析 TTF/VF、取轮廓、按 GPOS 取前进量 |
| 几何 | `shared/geometry.mjs` → `flattenOutline` | 二次/三次贝塞尔自适应展平（容差 0.0015 em） |
| 距离场内核 | `shared/sdf.mjs` → `signedDistance` / `buildGlyphTile` / `buildTileInRect` | 精确有符号距离、编码、按固定矩形重算（编辑器用） |
| 编码约定 | `shared/sdf.mjs` → `encodeDistance` / `decodeDistance` | 128=边缘，255=+rangeTexels（内），0=−rangeTexels（外） |
| 打包 | `shared/pack.mjs` → `packTiles` / `blitTile` | 确定性货架打包，写入图集 |
| 图集构建 | `shared/atlas-build.mjs` → `buildAtlasFromSources` | 字形 → 图块 → 图集 + 清单（ox/oy/advance/band） |
| CLI 构建 | `tools/build-atlas.mjs` | 生成 `web/atlas/*.{r8,png,json}`、`outlines.json`、`index.json` |
| 误差量测 | `tools/compare-report.mjs` | 距离场重建 vs 精确轮廓光栅化，输出报告与指标 |
| GPU 着色器 | `shared/shaders.mjs` → `TEXT_VERT` / `TEXT_FRAG` / `INSPECT_FRAG` | 距离解码、屏幕空间 1px 阈值、图块边界拒绝 |
| GPU 渲染器 | `web/js/renderer.js` → `SdfTextRenderer` | 实例化绘制、R8 上传、编辑器原地回写 |
| 排版 | `shared/layout.mjs` → `shapeLine` / `layoutParagraph` / `measureText` | 前进量排版，图块边距不参与字距 |
| 距离场检查器 | `web/js/field.js` | 原始 R8 / 有符号距离 / 阈值字形三种视图 + 重建条带 |
| 矢量编辑器 | `web/js/editor.js` | 拖点、缩放、描边，调用同一内核，回写图集 |
| 误差界面 | `web/js/audit.js` | 读取 `docs/report/metrics.json` 呈现 |

## 2. 三个必须分开的概念

1. **字形图形范围**：轮廓的墨迹包围盒，决定图块要覆盖多少像素。图块还额外加
   `padTexels` 空白边。清单里的 `left/top/tileEmW/tileEmH` 是图块的 em 矩形。
2. **排版前进量**：字体度规 `advance`（em），来自 `hmtx` / GPOS。`shared/layout.mjs`
   的笔位只累加 `advance + tracking`，再乘字号。**图块贴图宽度从不参与间距计算。**
3. **图集像素边距**：`padTexels`，纯纹理安全区，布局惰性。它只保证图块边框的场值
   饱和，从而双线性采样不可能读到邻字。

三者分离由测试直接断言（见第 6 节）。

## 3. 距离编码与采样缩放（进入着色器）

- 编码：`byte = 128 + 127 * (dTexels / rangeTexels)`，钳制到 0..255。
- 着色器解码：`dTexels = ((b*255 - 128) / 127) * rangeTexels`，
  再 `dPx = dTexels / texelsPerEm * pxPerEm`。
- 两个参数随每个实例上传（`a_glyph = (rangeTexels, texelsPerEm, pxPerEm)`），
  因此不同字号、不同图集的解码都在着色器内完成，不是预烘焙阈值。
- 抗锯齿是**固定的 1 屏幕像素斜坡**：`alpha = clamp(dPx / 1px + 0.5, 0, 1)`。
  所有字号用同一阈值——这是刻意选择；乳齿边缘差异来自场的采样带宽，
  由报告逐字号量化，而不是靠换阈值掩盖。

## 4. 图块边缘与颜色约定

- `padTexels > rangeTexels`（构建时校验，否则抛 `PAD_TOO_SMALL`）。图块最外圈
  场值饱和到“远在外侧”，双线性 tap 越界也只会得到同类值。
- 片元着色器再显式拒绝图块矩形之外的采样（`discard`），双保险。
- 图集是 **R8 线性数据**，以 `internalFormat=R8 / format=RED` 上传，**从不做 sRGB 解码**。
- 画布以 `alpha:false` 合成；文字颜色与覆盖度都在 **sRGB 显示空间**。
- 混合为**直通 alpha**：`SRC_ALPHA / ONE_MINUS_SRC_ALPHA`，上下文
  `premultipliedAlpha:false`，着色器不预乘。
- 详见 `docs/RENDER-CONTRACT.md`。

## 5. 图像入口（文件与视图）

- `web/atlas/<face>.r8`：GPU 上传用的原始字节。
- `web/atlas/<face>.png`：分发用灰度 PNG（同值，便于肉眼检查）。
- `web/atlas/<face>.json`：清单（每个字形的 tile 矩形、`ox/oy`、`advance`、band、kerning、settings）。
- `web/atlas/outlines.json`：矢量源（em 单位命令），编辑器与报告共用。
- `web/atlas/index.json`：总索引、约定、tour 文案、各字体 settings。
- 界面：导览（实际渲染）、距离场（三种解码）、字形编辑（内核驱动）、误差与图集。

## 6. 命令行（辅助，不替代图集）

```bash
node tools/fetch-fonts.mjs     # 校验内置字体哈希与许可证，并重建界面 Web 字体
node tools/build-atlas.mjs     # 生成图集与清单
node tools/compare-report.mjs  # 生成误差报告与样本条带
node tools/serve.mjs           # 本地静态服务器
```

命令行只负责**生成与量测**图集；运行时绘制完全在 GPU 上由清单驱动。

## 7. 测试

`npm test`（`node --test test/*.test.mjs`）覆盖：

- 编码/解码互逆与钳制；
- 精确距离的符号与零值；
- 图块边框饱和（`padTexels > rangeTexels` 时边框必为 0）；
- 前进量等于字体度规，且与图块宽度无关（改 `padTexels` 不改变 `measureText`）；
- 换行不产生行首标点（避头尾）；
- 所有导览文案的码点在对应图集中存在；
- 距离场重建与轮廓光栅化在阈值内的误差上界。

`npm run e2e`（Playwright）验证四个视图可切换、导览实例数 > 0、编辑器提交后图集
矩形变化、越界缩放触发 `PAD_BREACH`。
