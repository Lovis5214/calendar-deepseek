# Calendar_Deepseek

用 DeepSeek 从剪贴板**文字**或活动**海报图片**智能解析日历事件——支持一次解析出多个日程，一次性创建。

## 使用方式

命令启动时会自动判断输入来源，无需切换命令：

| 优先级 | 来源 | 怎么触发 |
| --- | --- | --- |
| 1 | 剪贴板截图 | `⌘⌃⇧4` 截图（剪贴板无文字时才当作海报） |
| 2 | 剪贴板中的图片文件 | 在 Finder 里 `⌘C` 复制图片 |
| 3 | Finder 选中的图片 | 在 Finder 里选中图片后运行 |
| 4 | 剪贴板文字 | `⌃⌥C` 或手动 `⌘C` |

解析出日程后 → 表单中可编辑/移除（Remove Event N）→ 点 **Confirm Events** 全部创建。

### 文字流程

1. 在任意应用中**选中**包含日程的文字（微信、Notes、浏览器等均可）
2. 按 `⌃⌥C`（Control + Option + C，即快捷指令「从选中文字建日历」）
3. 快捷指令会自动 Cmd+C 复制选中文字，并唤起插件

### 海报流程

1. `⌘⌃⇧4` 截取海报（或在 Finder 中复制/选中海报图片）
2. 运行插件命令
3. 插件会先用 macOS Vision 框架在**本机**做一次 OCR，再把「OCR 文字 + 海报图片」一起交给 DeepSeek 视觉模型——本机 OCR 补足密集小字的精度，图片保证版面归属（哪个时间对应哪场活动）不会错配

也可在表单里用 **Pick Poster Image…** 手动选图，或用 **Use Clipboard Text** 强制走文字流程。

## 快捷指令创建（macOS「快捷指令」App）

1. 新建快捷指令（如：从选中文字建日历）
2. 添加「**运行 AppleScript**」动作：
   ```applescript
   tell application "System Events" to keystroke "c" using {command down}
   ```
3. 添加「**打开 URL**」动作：
   ```
   raycast://extensions/lovis_yang/calendar-deepseek/calendar
   ```
   （也可在插件命令界面 `⌘K` → Copy Deeplink 获取）
4. 快捷指令详情 → 绑定**键盘快捷键 `⌃⌥C`**
5. 首次运行：
   - 系统提示**授权辅助功能** → 允许（System Events 模拟 Cmd+C 需要）
   - Raycast 询问是否打开该命令 → 选**始终允许**

## 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| API | — | DeepSeek API Key |
| TargeCalendar | — | 事件写入的目标日历名 |
| Vision Model | `deepseek-v4-flash-vision-exp` | 海报识别模型，实验模型 id 失效时可改 |
| Poster Detail | High | High 发原分辨率；Low 缩到 512×512，更快更省 |
| Poster OCR | 开 | 关掉则只发图片，不做本机 OCR |

## 说明

- 插件只读取剪贴板：先复制（快捷指令或手动 Cmd+C）再运行；也可以点插件内的 **Read Clipboard Again** 重新读取
- **从 Word/Outlook 复制的富文本**会同时带图片标志，插件会正确识别为文字而非海报
- 海报常只写月日不写年份：默认按当前年份推断，若已过期则用下一年，推断依据会显示在 **Needs Confirmation** 里，请确认后再创建
- 每条日程校验：标题非空、时间合法、结束晚于开始；无效条目会被跳过并提示
- 海报识别不依赖任何第三方库：OCR 用 macOS 自带 Vision 框架，图片处理用自带 `sips`
