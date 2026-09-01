# Calendar_Deepseek

用 DeepSeek 从剪贴板文本智能解析日历事件——支持一条消息解析出多个日程，一次性创建。

## 使用方式

1. 在任意应用中**选中**包含日程的文字（微信、Notes、浏览器等均可）
2. 按 `⌃⌥C`（Control + Option + C，即快捷指令「从选中文字建日历」）
3. 快捷指令会自动 Cmd+C 复制选中文字，并唤起插件
4. 插件解析出日程 → 表单中可编辑/移除（Remove Event N）→ 点 **Confirm Events** 全部创建

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

## 说明

- 插件只读取剪贴板：先复制（快捷指令或手动 Cmd+C）再运行；也可以点插件内的 **Read Clipboard Again** 读取新复制的内容
- 没复制内容时运行会提示先复制
- 每条日程校验：标题非空、时间合法、结束晚于开始；无效条目会被跳过并提示
