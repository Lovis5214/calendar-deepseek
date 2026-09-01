# CLAUDE.md

Raycast 扩展：从剪贴板**文字**或活动**海报图片**创建 Calendar.app 日程。单命令 `calendar`（mode `view`）。

仓库 https://github.com/Lovis5214/calendar-deepseek ｜ 扩展 id `lovis_yang/calendar-deepseek`

## 命令

```bash
npm run dev        # ray develop，改动热重载
npm run lint       # ray lint（含 package.json 校验 + ESLint + Prettier）
npm run fix-lint   # 自动修格式，提交前跑这个
npm run build      # ray build
```

TypeScript strict，`npx tsc --noEmit` 可单独类型检查。

## 架构

| 文件 | 职责 |
| --- | --- |
| `src/calendar.tsx` | 全部状态、表单、DeepSeek 调用、JXA 写日历 |
| `src/lib/image.ts` | 魔数嗅探、`sips` 归一化、剪贴板图片转存 |
| `src/lib/ocr.ts` | JXA + macOS Vision 框架本机 OCR |

**零第三方依赖**（除 `@raycast/api`、`@raycast/utils`）。OCR 和图片处理全用 macOS 自带的 `osascript` 与 `sips`——加依赖前先确认自带工具真的做不到。

数据流：`loadEvent` → `detectSource` → `applyText`/`applyImage` → `completeDeepSeek` → `extractJson` → `buildDrafts` → 表单 → `confirmEvents` → `createCalendarEvents`（JXA，时间传 epoch-ms）。

两条链路汇合于 `CalendarDraft[]`，所以 `confirmEvents`/`createCalendarEvents`/`renderEventFields` 对来源无感知。

## 输入探测链（`detectSource`，顺序有讲究）

1. **剪贴板裸图** —— 仅当剪贴板**没有文字**时
2. **剪贴板图片文件**（`Clipboard.read().file`）—— 优先于文字
3. **Finder 选中图片** —— 优先于文字
4. **剪贴板文字** —— 原有行为

第 1 步的 `!hasText` 门槛不能去掉：Word/Outlook 复制富文本会**同时**在剪贴板放文字和 TIFF 图片标志，去掉门槛会把复制的邮件文字当海报处理，破坏原有文字流程。截图（`⌘⌃⇧4`）是纯图无文字，所以照常走海报。

## DeepSeek 调用

同一个 OpenAI 兼容端点 `https://api.deepseek.com/chat/completions`，`completeDeepSeek` 按来源切换：

- 文字 → `deepseek-v4-flash`
- 海报 → `deepseek-v4-flash-vision-exp`（可被 `visionModel` 偏好覆盖）

**海报是双输入**：本机 OCR 文本 + 图片一起发。图片单发会丢密集小字（DeepSeek 每图最多 384 token，约等效 800×800）；OCR 单发会丢版面归属（哪个日期对应哪场活动）。两者互补，缺一不可——改动这里前先想清楚这点。

图片必须放在 **user 消息**里，放 system 会 400。

两处防御：`completeDeepSeek` 收到 400 会依次去掉 `response_format`、`thinking` 重试；`extractJson` 能从代码围栏和多余散文里抠出 JSON。**未确认视觉模型是否真的支持 `response_format`**——实测能跑通，但不知道走没走降级。要查就在重试分支加日志。

## 已验证的环境事实（别再重新查）

- **`Clipboard.ReadContent` 只有 `{ text, file?, html? }`，没有 image 字段**。截图裸图 Raycast API 读不到，必须 AppleScript 转存。
- **Raycast `Form` 没有图片渲染组件**，`Form.Description` 只能显示文字。海报无法内嵌预览，只能显示文件名 + `open()` 调预览。
- **`sips -Z N` 会把小图放大**（实测 400px → 2048px），不是只缩不放。`normalizeImage` 只在超过 2048px 时才加 `-Z`，这个条件是必需的。
- **macOS 剪贴板同时存多种格式**。复制一张图会有 9 种（PNGf/AVIF/8BPS/GIF/jp2/JPEG/TIFF/BMP/TPIC）。`clipboard info` 可读，`as text` 强制转换正常。
- **JXA 的 ObjC 桥接能直接调 Vision 框架**，无需编译。支持 30 种语言，含 `zh-Hans`/`zh-Hant`/`en-US`。`recognitionLevel = 0` 是 accurate。`boundingBox` 原点在**左下**，所以 y 降序才是从上到下。
- **`«class PNGf»` 转存不需要 `as` 子句**（macOS 26.6.2 实测，字节与原图一致）。
- DeepSeek 图片限制：请求体 48MiB、单边 8192px、支持 JPEG/PNG/GIF/WebP（按字节嗅探，不看扩展名）、`detail` 可选 `low`/`high`/`original`/`auto`。

## 约束

- 偏好新增必须 `required: false` 并给 `default`，否则会破坏现有快捷指令 deep link `raycast://extensions/lovis_yang/calendar-deepseek/calendar`。
- 改 `TEXT_PROMPT` 要谨慎，那是已调好的文字链路；海报用独立的 `POSTER_PROMPT`。
- 临时文件在 `environment.supportPath/poster-tmp`，每次 `loadEvent` 开头清理。不能用 `finally` 删——表单打开期间预览还要用。

## 未验证

Finder 复制/选中两条路径、`Poster Detail: Low`、`enableOcr` 开关的 A/B 效果、Word/Outlook 富文本走文字路径（该行为是推断，非实测）。
