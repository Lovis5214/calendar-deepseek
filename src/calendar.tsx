import {
  Action,
  ActionPanel,
  Clipboard,
  Form,
  Toast,
  closeMainWindow,
  environment,
  getPreferenceValues,
  getSelectedFinderItems,
  open,
  showInFinder,
  showToast,
} from "@raycast/api";
import { Fragment, useEffect, useRef, useState } from "react";
import { runAppleScript } from "@raycast/utils";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_B64_BYTES,
  dumpClipboardImage,
  looksLikeImage,
  mimeForFormat,
  normalizeFilePath,
  normalizeImage,
} from "./lib/image";
import { ocrImage } from "./lib/ocr";

type Preferences = {
  deepseekApiKey: string;
  calendarName: string;
  visionModel?: string;
  imageDetail?: "low" | "high";
  enableOcr?: boolean;
};

type ApiResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type ApiEvent = {
  title: string;
  start: string;
  end: string;
  location?: string;
  notes?: string;
  ambiguity?: string;
};

type ApiEventsResponse = {
  events: ApiEvent[];
};

type CalendarDraft = {
  title: string;
  start: Date;
  end: Date;
  location: string;
  notes: string;
  ambiguity: string;
};

type SourceKind = "text" | "image";

type ImageMeta = {
  /** The file the user gave us, shown in the UI and used for OCR at full resolution. */
  sourcePath: string;
  /** The normalized file actually sent to the API. */
  path: string;
  mime: string;
  width: number;
  height: number;
};

type MessagePart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "low" | "high" } };

type DetectedSource = { kind: "image"; path: string; label: string } | { kind: "text"; text: string };

const TEXT_MODEL = "deepseek-v4-flash";
const DEFAULT_VISION_MODEL = "deepseek-v4-flash-vision-exp";

const TMP_DIR = path.join(environment.supportPath, "poster-tmp");

const TEXT_PROMPT =
  '从消息提取日历事件，输出JSON对象：{"events":[{"title":"","start":"","end":"","location":"","notes":"","ambiguity":""}, {...}]}。若消息包含多个日程则全部提取并按开始时间排序，放入events数组；若没有日程返回{"events":[]}。相对日期基于所给时间和时区；缺少结束时间则默认1小时；时间使用ISO 8601；保留重要信息；不确定项写入ambiguity；不要虚构。';

const POSTER_PROMPT =
  '你是海报信息提取助手。从活动海报图片中提取日历事件，输出JSON对象：{"events":[{"title":"","start":"","end":"","location":"","notes":"","ambiguity":""}, {...}]}。要求：' +
  "1. 提取活动名称(title)、日期时间、地点(location，含具体场馆与厅室)；主讲人/嘉宾写入title或notes；票价、报名方式、主办方等有用信息写入notes。中英文海报均可，title与location保留海报原语言。" +
  "2. 若海报含多个场次、多天、多个时间段或多个城市，全部提取为独立事件，按开始时间排序放入events数组。" +
  "3. 海报常只写月日不写年份：默认用所给Now的年份；若该日期早于Now则用下一年；跨年区间(如12月30日至1月2日)结束日期用下一年。推断依据必须写入ambiguity。" +
  "4. 时间为区间(如14:00-17:00)时按区间填start与end；只有开始时间则默认持续1小时。" +
  "5. 随图提供的OCR文本由机器提取、可能有错漏，仅作文字参考；哪个日期时间属于哪个活动，以图片版面为准。" +
  "6. 不要虚构海报上不存在的信息；缺年份、时间不全、地点为推测等一律用中文简要写入ambiguity。" +
  '7. 时间使用ISO 8601并含时区偏移，基于所给Now与Timezone。若图中没有日历事件(如纯广告或只有二维码)，返回{"events":[]}。';

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();

  const [isLoading, setIsLoading] = useState(true);
  const [sourceText, setSourceText] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("text");
  const [sourceLabel, setSourceLabel] = useState("");
  const [image, setImage] = useState<ImageMeta | null>(null);
  const [drafts, setDrafts] = useState<CalendarDraft[]>([]);
  const filePickerRef = useRef<Form.FilePicker>(null);

  useEffect(() => {
    void loadEvent();
  }, []);

  async function loadEvent() {
    setIsLoading(true);
    try {
      await cleanupTmp();

      const source = await detectSource();

      if (!source) {
        throw new Error(
          "Copy a poster (screenshot or image file) or some text, or select an image in Finder, then run again.",
        );
      }

      if (source.kind === "image") {
        await applyImage(source.path, source.label);
      } else {
        await applyText(source.text, "Could not read clipboard");
      }
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Nothing to read",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsLoading(false);
    }
  }

  /**
   * Looks for a poster first and falls back to the original clipboard-text
   * behavior. Every step fails quietly so one unavailable source never blocks
   * the others.
   */
  async function detectSource(): Promise<DetectedSource | null> {
    const text = await Clipboard.readText();
    const hasText = Boolean(text?.trim());

    // A screenshot puts image data on the pasteboard and nothing else, but a
    // rich-text copy from Word or Outlook carries a TIFF flavor alongside the
    // text. Those are text, so only treat raw pasteboard image data as a poster
    // when no text came with it.
    if (!hasText) {
      const dumpPath = path.join(TMP_DIR, "clipboard.png");
      if (await dumpClipboardImage(dumpPath)) {
        return { kind: "image", path: dumpPath, label: "Clipboard screenshot" };
      }
    }

    // A copied image file is unambiguous even when its name is also on the
    // pasteboard as text, so this outranks the text path.
    try {
      const content = await Clipboard.read();
      if (content.file) {
        const filePath = normalizeFilePath(content.file);
        if (await looksLikeImage(filePath)) {
          return { kind: "image", path: filePath, label: path.basename(filePath) };
        }
      }
    } catch {
      // Clipboard unreadable — try the next source.
    }

    // Being in Finder with an image selected is a deliberate act, so it
    // outranks whatever happens to be sitting in the clipboard.
    try {
      for (const item of await getSelectedFinderItems()) {
        if (await looksLikeImage(item.path)) {
          return { kind: "image", path: item.path, label: path.basename(item.path) };
        }
      }
    } catch {
      // Finder not frontmost or nothing selected.
    }

    if (hasText && text) {
      return { kind: "text", text };
    }

    return null;
  }

  async function cleanupTmp() {
    try {
      await fs.rm(TMP_DIR, { recursive: true, force: true });
    } catch {
      // Best effort — a leftover file is harmless.
    }
    await fs.mkdir(TMP_DIR, { recursive: true });
  }

  async function applyText(text: string, errorTitle: string) {
    try {
      if (!text?.trim()) {
        throw new Error("The clipboard is empty. Copy (⌃⌥C or Cmd+C) in the source app first, then run again.");
      }

      setSourceKind("text");
      setSourceText(text);
      setImage(null);
      setDrafts(await parseEvents(text));
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: errorTitle,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async function applyImage(imagePath: string, label: string) {
    try {
      const normalized = await normalizeImage(imagePath, TMP_DIR);

      // OCR reads the untouched original for maximum text fidelity while the
      // API gets the downscaled copy; both are independent, so run them together.
      const [base64, ocrText] = await Promise.all([
        fs.readFile(normalized.path, "base64"),
        preferences.enableOcr === false ? Promise.resolve("") : ocrImage(imagePath),
      ]);

      if (base64.length > MAX_B64_BYTES) {
        throw new Error("Image is too large to send to the API.");
      }

      const meta: ImageMeta = {
        sourcePath: imagePath,
        path: normalized.path,
        mime: mimeForFormat(normalized.format),
        width: normalized.width,
        height: normalized.height,
      };

      setSourceKind("image");
      setSourceLabel(label);
      setSourceText("");
      setImage(meta);
      setDrafts(await parseEventsFromImage(meta, base64, ocrText));
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not read the poster",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Shared DeepSeek call for both sources. `response_format` and `thinking` are
   * undocumented for the vision model, so a 400 retries without them before
   * giving up.
   */
  async function completeDeepSeek(parts: MessagePart[], mode: SourceKind): Promise<string> {
    const isPoster = mode === "image";

    for (let attempt = 0; ; attempt++) {
      const body: Record<string, unknown> = {
        model: isPoster ? preferences.visionModel?.trim() || DEFAULT_VISION_MODEL : TEXT_MODEL,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 3000,
        messages: [
          { role: "system", content: isPoster ? POSTER_PROMPT : TEXT_PROMPT },
          // Images are only allowed in user messages.
          { role: "user", content: parts },
        ],
      };

      if (attempt >= 1) delete body.response_format;
      if (attempt >= 2) delete body.thinking;

      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${preferences.deepseekApiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const result = (await response.json()) as ApiResponse;
        const content = result.choices?.[0]?.message?.content;

        if (!content) {
          throw new Error("DeepSeek returned an empty response.");
        }

        return content;
      }

      if (response.status === 400 && attempt < 2) {
        continue;
      }

      const detail = await response.text().catch(() => "");
      throw new Error(`DeepSeek API returned HTTP ${response.status}.${detail ? ` ${detail.slice(0, 200)}` : ""}`);
    }
  }

  async function parseEvents(text: string): Promise<CalendarDraft[]> {
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const content = await completeDeepSeek(
      [{ type: "text", text: `Now: ${now.toISOString()}\nTimezone: ${timeZone}\nMessage: ${text}` }],
      "text",
    );

    return buildDrafts(content, "message");
  }

  async function parseEventsFromImage(meta: ImageMeta, base64: string, ocrText: string): Promise<CalendarDraft[]> {
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const parts: MessagePart[] = [
      { type: "text", text: `Now: ${now.toISOString()}\nTimezone: ${timeZone}\n以下是活动海报图片。` },
    ];

    if (ocrText) {
      parts.push({ type: "text", text: `[本机OCR文本，可能有错漏，版面归属以图片为准]\n${ocrText}` });
    }

    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${meta.mime};base64,${base64}`,
        detail: preferences.imageDetail === "low" ? "low" : "high",
      },
    });

    const content = await completeDeepSeek(parts, "image");

    return buildDrafts(content, "poster");
  }

  /**
   * Pulls the JSON object out of a completion. The model is asked for raw JSON,
   * but the vision variant may not honor `response_format`, so tolerate code
   * fences and surrounding prose.
   */
  function extractJson(content: string): string {
    let text = content.trim();

    const fence = /^```(?:json)?\s*/i.exec(text);
    if (fence) {
      text = text
        .slice(fence[0].length)
        .replace(/```\s*$/, "")
        .trim();
    }

    const start = text.indexOf("{");
    if (start === -1) {
      throw new Error("DeepSeek returned an invalid response.");
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const character = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth++;
      } else if (character === "}") {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }

    throw new Error("DeepSeek returned an invalid response.");
  }

  async function buildDrafts(content: string, sourceNoun: string): Promise<CalendarDraft[]> {
    const parsed = JSON.parse(extractJson(content)) as ApiEventsResponse;

    if (!parsed || !Array.isArray(parsed.events)) {
      throw new Error("DeepSeek returned an invalid response.");
    }

    const nextDrafts: CalendarDraft[] = [];
    let skipped = 0;

    for (const event of parsed.events) {
      const start = new Date(event.start);
      const end = new Date(event.end);

      if (!event.title?.trim() || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
        skipped++;
        continue;
      }

      nextDrafts.push({
        title: event.title,
        start,
        end,
        location: event.location ?? "",
        notes: event.notes ?? "",
        ambiguity: event.ambiguity ?? "",
      });
    }

    if (nextDrafts.length === 0) {
      throw new Error(`No events found in the ${sourceNoun}.`);
    }

    if (skipped > 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: `Skipped ${skipped} invalid event${skipped === 1 ? "" : "s"}`,
      });
    }

    return nextDrafts;
  }

  function updateDraft(index: number, changes: Partial<CalendarDraft>) {
    setDrafts((current) => current.map((draft, i) => (i === index ? { ...draft, ...changes } : draft)));
  }

  function removeDraft(index: number) {
    setDrafts((current) => current.filter((_, i) => i !== index));
  }

  async function confirmEvents() {
    if (drafts.length === 0) {
      return;
    }

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Creating ${drafts.length} event${drafts.length === 1 ? "" : "s"}...`,
    });

    try {
      await createCalendarEvents(drafts);

      toast.style = Toast.Style.Success;
      toast.title = `${drafts.length} event${drafts.length === 1 ? "" : "s"} created`;
      toast.message = preferences.calendarName;

      await closeMainWindow();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Could not create events";
      toast.message = error instanceof Error ? error.message : "Unknown error";
    }
  }

  async function createCalendarEvents(events: CalendarDraft[]) {
    const script = `
function run(argv) {
  const Calendar = Application("Calendar");
  const calendars = Calendar.calendars.whose({ name: argv[0] })();

  if (calendars.length === 0) {
    throw new Error("Calendar not found: " + argv[0]);
  }

  const events = JSON.parse(argv[1]);

  for (const data of events) {
    const event = Calendar.Event({
      summary: data.title,
      location: data.location,
      description: data.notes,
      startDate: new Date(Number(data.start)),
      endDate: new Date(Number(data.end)),
    });

    calendars[0].events.push(event);
  }
}
    `;

    await runAppleScript(
      script,
      [
        preferences.calendarName,
        JSON.stringify(
          events.map((event) => ({
            title: event.title,
            location: event.location,
            notes: event.notes,
            start: event.start.getTime(),
            end: event.end.getTime(),
          })),
        ),
      ],
      {
        language: "JavaScript",
      },
    );
  }

  async function useClipboardText() {
    setIsLoading(true);
    try {
      const text = await Clipboard.readText();
      await applyText(text ?? "", "Could not read clipboard");
    } finally {
      setIsLoading(false);
    }
  }

  function renderEventFields(draft: CalendarDraft, index: number) {
    return (
      <>
        <Form.TextField
          id={`title-${index}`}
          title="Title"
          value={draft.title}
          onChange={(title) => updateDraft(index, { title })}
        />

        <Form.DatePicker
          id={`start-${index}`}
          title="Start"
          value={draft.start}
          onChange={(start) => {
            if (start) updateDraft(index, { start });
          }}
        />

        <Form.DatePicker
          id={`end-${index}`}
          title="End"
          value={draft.end}
          onChange={(end) => {
            if (end) updateDraft(index, { end });
          }}
        />

        <Form.TextField
          id={`location-${index}`}
          title="Location"
          value={draft.location}
          onChange={(location) => updateDraft(index, { location })}
        />

        <Form.TextArea
          id={`notes-${index}`}
          title="Notes"
          value={draft.notes}
          onChange={(notes) => updateDraft(index, { notes })}
        />

        {draft.ambiguity ? <Form.Description title="Needs Confirmation" text={draft.ambiguity} /> : null}
      </>
    );
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Confirm Events" onSubmit={confirmEvents} />
          {drafts.length > 1
            ? drafts.map((draft, index) => (
                <Action
                  key={`remove-${index}`}
                  title={`Remove Event ${index + 1}`}
                  onAction={() => removeDraft(index)}
                />
              ))
            : null}
          <Action title="Read Clipboard Again" onAction={loadEvent} />
          <Action title="Pick Poster Image…" onAction={() => filePickerRef.current?.focus()} />
          {image ? <Action title="Preview Poster" onAction={() => open(image.sourcePath)} /> : null}
          {image ? <Action title="Show Poster in Finder" onAction={() => showInFinder(image.sourcePath)} /> : null}
          <Action title="Use Clipboard Text" onAction={useClipboardText} />
        </ActionPanel>
      }
    >
      <Form.FilePicker
        id="poster"
        title="Poster"
        ref={filePickerRef}
        allowMultipleSelection={false}
        canChooseDirectories={false}
        value={image ? [image.sourcePath] : []}
        onChange={(files) => {
          if (files.length > 0) {
            void applyImage(files[0], path.basename(files[0]));
          }
        }}
      />

      <Form.Description
        title={sourceKind === "image" ? "Poster Source" : "Clipboard Text"}
        text={
          sourceKind === "image"
            ? `${sourceLabel}${image ? ` — ${image.width}×${image.height}` : ""}`
            : sourceText || "Reading clipboard..."
        }
      />

      {drafts.length > 0 ? (
        <>
          {drafts.length === 1
            ? renderEventFields(drafts[0], 0)
            : drafts.map((draft, index) => (
                <Fragment key={index}>
                  {index > 0 ? <Form.Separator /> : null}
                  <Form.Description title={`Event ${index + 1}`} text={draft.title} />
                  {renderEventFields(draft, index)}
                </Fragment>
              ))}

          <Form.Description title="Calendar" text={preferences.calendarName} />
        </>
      ) : null}
    </Form>
  );
}
