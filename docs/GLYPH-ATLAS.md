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
| 动态字形源 | `tools/build-dynamic-sources.mjs` → `web/atlas/dynamic-sources.json` | 固定图集未覆盖码点的 em 轮廓池（构建期抽取，浏览器不解析字体） |
| 动态缓存内核 | `shared/dynamic-atlas.mjs` → `DynamicGlyphCache` / `FrameLayoutCache` | 有界 LRU、引用计数、代次（epoch）身份、占位与缺字状态机 |
| 动态字形供给 | `shared/dynamic-provider.mjs` → `DynamicGlyphProvider` | 用同一 SDF 内核运行时生成图块、构造共享占位符 |
| 动态排版 | `shared/dynamic-layout.mjs` → `DynamicShaper` | 固定/动态/占位三类带代次的放置记录、字体回退 |
| 动态 GPU 桥 | `web/js/gl-dynamic-atlas.js` → `GlDynamicAtlas` | 固定 R8 纹理、槽位上传、GL fence 完成边界回收 |
| 动态系统装配 | `web/js/dynamic-system.js` → `createDynamicSystem` | 浏览器侧把上面四块接成一个外观对象 |
| 动态状态页 | `web/js/dynamic-view.js` | 待生成 / 已上传可绘制 / 缺字 / 等待 GPU 回收的实况网格与计数 |

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

## 6. 动态有界图集（运行中出现的新文字）

固定图集只覆盖导览文案与 ASCII。访客切换语言、输入固定图集没有的字符时，这些字形在
**运行时**经同一 SDF 内核生成并上传到一张**容量固定**的动态纹理，绝不靠无限扩图回避
生命周期。链路由四个文件构成，且 GL 无关部分可在 Node 用假 GL 单测：

- `shared/dynamic-atlas.mjs`：平台无关的缓存状态机。
- `shared/dynamic-provider.mjs`：从 `dynamic-sources.json` 的 em 轮廓生成 R8 图块。
- `shared/dynamic-layout.mjs`：把固定/动态/缺字统一成带代次的放置记录。
- `web/js/gl-dynamic-atlas.js`：WebGL2 R8 纹理与 fence 回收。

### 6.1 生命周期与不变量

1. **有界 + 引用钉扎**：容量 = 槽位数（默认网格 8×8 减去 1 个共享占位单元，即 56）。
   满了就按 LRU 回收，但只回收 `refs === 0` 的槽位；当前帧仍在绘制的字形引用计数 > 0，
   永远不会被挤出或被别的字符占槽。无可用槽位时返回显式 `busy / ATLAS_BUSY`，而不是溢出。
2. **代次身份（epoch）**：每个槽位与每个字形身份都带单调递增的 epoch。槽位被回收给新字符
   会取得新 epoch；迟到的生成任务回传时若 epoch/face/cp 对不上即被拒绝（计入
   `rejectedStale`），**旧任务永远无法覆盖新分配对象**。
3. **排版缓存失效**：`FrameLayoutCache` 的每条记忆都带解析时的 epoch，并对照存活槽位校验；
   坐标一旦回收即失效，排版不会继续引用已失效坐标。
4. **显式占位，杜绝残影**：保留一个共享空心方框（tofu）单元。待生成、缺字、容量不足都采样
   该占位符；回收的槽位在 fence 确认后清零为“远在外侧”（字节 0），因此任何时刻都不会把
   上一个占用者的像素显示出来。
5. **GPU 完成边界**：回收不是删除 JS 引用。`GlDynamicAtlas.recycleSlot` 先 `fenceSync`
   并把槽位置入 `parked`，`pumpFences` 轮询到 `SYNC_GPU_COMMANDS_COMPLETE` 后才 `clearSlot`
   并归还；不支持 fence 时退化为 `gl.finish()` 这一真实完成边界。纹理对象与尺寸始终不变，
   `vramBytes()` 恒等于 `width*height`。

### 6.2 状态页

「动态图集」页直接读取运行中的缓存与 GL 桥，不另算一套口径：网格逐槽位显示
空闲 / 待生成（占位）/ 已上传可绘制 / 缺字占位 / 等待 GPU；侧栏给出容量、累计上传与回收、
迟到任务被拒、容量不足次数、布局代次，以及实际显存范围（纹理尺寸、R8 字节数、上传/清理/
fence 计数）。回收、销毁、重建按钮驱动同一条状态机。

### 6.3 矢量编辑窗口接入

「字形编辑」页的“图集来源”可切到动态图集。列表只列**已驻留**的字形（未生成者没有可回写的
GPU 槽位）；选中后缩放、描边、拖点都调用与固定图集相同的内核（`buildTileInRect` +
`checkTileMargins`），在槽位固定矩形内重算，并把实测字边宽度与清晰度（`measureEdgeProfile`
从真实解码场梯度算出，非启发式估计）显示在结果区。提交时做 epoch 校验后经
`glAtlas.uploadTile` 原地回写，保留 `ox/oy` 与前进量；槽位已被回收则报 `STALE_SLOT`，
图块超过单元报 `TILE_OVERFLOW`，边距不足报 `PAD_BREACH`，异常都显示在编辑器错误区。
CLI 只产出字形源，不替代这个窗口交互。

## 7. 命令行（辅助，不替代图集）

```bash
node tools/fetch-fonts.mjs          # 校验内置字体哈希与许可证，并重建界面 Web 字体
node tools/build-atlas.mjs          # 生成固定图集与清单
node tools/build-dynamic-sources.mjs # 生成运行时按需字形源 dynamic-sources.json（npm run dynamic）
node tools/compare-report.mjs       # 生成误差报告与样本条带
node tools/serve.mjs                # 本地静态服务器
```

命令行只负责**生成与量测**图集（含动态字形源）；运行时绘制、缓存、回收完全在 GPU 上由
清单与动态状态机驱动。`npm run build` 会在固定图集后自动重建动态字形源。

## 8. 测试

`npm test`（`node --test test/*.test.mjs`）覆盖：

- 编码/解码互逆与钳制；
- 精确距离的符号与零值；
- 图块边框饱和（`padTexels > rangeTexels` 时边框必为 0）；
- 前进量等于字体度规，且与图块宽度无关（改 `padTexels` 不改变 `measureText`）；
- 换行不产生行首标点（避头尾）；
- 所有导览文案的码点在对应图集中存在；
- 距离场重建与轮廓光栅化在阈值内的误差上界；
- **动态有界图集全生命周期**（`test/dynamic-atlas.test.mjs`，用录制型假 GL 在 CPU 镜像
  纹理与可手动置位的 fence 上断言）：占位→驻留 epoch 稳定、同字形并发去重、容量钉扎与
  ATLAS_BUSY、LRU fence 回收、迟到任务不能覆盖新占用者、缺字占位、fence 后才清像素且
  显存范围恒定、销毁在完成边界删纹理、排版缓存随代次失效、快速切语言不越界、TILE_OVERFLOW
  拒绝，以及编辑器动态重算的同槽回写与 `STALE_SLOT` 守卫。

`npm run e2e`（Playwright）验证四个视图可切换、导览实例数 > 0、编辑器提交后图集
矩形变化、越界缩放触发 `PAD_BREACH`。
