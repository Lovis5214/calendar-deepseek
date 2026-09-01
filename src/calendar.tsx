import {
  Action,
  ActionPanel,
  Clipboard,
  Form,
  closeMainWindow,
  getPreferenceValues,
  showToast,
  Toast,
} from "@raycast/api";
import { Fragment, useEffect, useState } from "react";
import { runAppleScript } from "@raycast/utils";

type Preferences = {
  deepseekApiKey: string;
  calendarName: string;
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

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();

  const [isLoading, setIsLoading] = useState(true);
  const [sourceText, setSourceText] = useState("");
  const [drafts, setDrafts] = useState<CalendarDraft[]>([]);

  useEffect(() => {
    void loadEvent();
  }, []);

  async function loadEvent() {
    setIsLoading(true);
    try {
      const text = await Clipboard.readText();
      await applyText(text ?? "", "Could not read clipboard");
    } finally {
      setIsLoading(false);
    }
  }

  async function applyText(text: string, errorTitle: string) {
    try {
      if (!text?.trim()) {
        throw new Error("The clipboard is empty. Copy (⌃⌥C or Cmd+C) in the source app first, then run again.");
      }

      setSourceText(text);
      setDrafts(await parseEvents(text));
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: errorTitle,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async function parseEvents(text: string): Promise<CalendarDraft[]> {
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const prompt =
      '从消息提取日历事件，输出JSON对象：{"events":[{"title":"","start":"","end":"","location":"","notes":"","ambiguity":""}, {...}]}。若消息包含多个日程则全部提取并按开始时间排序，放入events数组；若没有日程返回{"events":[]}。相对日期基于所给时间和时区；缺少结束时间则默认1小时；时间使用ISO 8601；保留重要信息；不确定项写入ambiguity；不要虚构。';

    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${preferences.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        thinking: {
          type: "disabled",
        },
        response_format: {
          type: "json_object",
        },
        temperature: 0.1,
        max_tokens: 3000,
        messages: [
          {
            role: "system",
            content: prompt,
          },
          {
            role: "user",
            content: `Now: ${now.toISOString()}\nTimezone: ${timeZone}\nMessage: ${text}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API returned HTTP ${response.status}.`);
    }

    const result = (await response.json()) as ApiResponse;
    const content = result.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("DeepSeek returned an empty response.");
    }

    const parsed = JSON.parse(content) as ApiEventsResponse;

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
      throw new Error("No events found in the message.");
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
        </ActionPanel>
      }
    >
      <Form.Description title="Clipboard Text" text={sourceText || "Reading clipboard..."} />

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
