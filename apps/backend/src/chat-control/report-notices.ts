import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../ids.ts";
import { now } from "../time.ts";
import type { ReportConsumer, ReportOrigin, RunReport } from "./run-reports.ts";
import { runReference } from "./run-tools.ts";
import { clip, MESSAGE_LIMIT, name, runHeading } from "./status-cards.ts";

type MatterKind = RunReport["needsInput"][number]["kind"];
/** A pending attention matter as a report lists it. */
type Matter = Pick<RunReport["needsInput"][number], "id" | "kind" | "block" | "appearedAt">;
type MatterNoticePurpose = "attention" | "catch-up";
type DeliveryState =
  | "owed"
  | "sending"
  | "delivered"
  | "failed"
  | "unknown"
  | "cancelled"
  | "lost"
  | "retired";

/** Matters one attention notice lists, so each keeps its own line within one Discord message. */
const MATTERS_PER_NOTICE = 8;
/** Entries a notice lists before summarizing the rest, shrunk until it fits one message. */
const NOTICE_LIMITS = [Infinity, 8, 4, 2, 1, 0] as const;
const NOTICE_TEXT_LIMIT = MESSAGE_LIMIT - "<@99999999999999999999> ".length;

const NEEDS_INPUT = new Set<MatterKind>(["human", "native-request", "conversation-waiting"]);

/** What each matter is, and while pending, where it is answered. */
const MATTERS: Record<MatterKind, { what: (block: string) => string; pending?: string }> = {
  human: {
    what: (block) => `Human step ${block} waits for an answer`,
    pending: "ask here to answer it",
  },
  "native-request": {
    what: (block) => `${block} has a T3 request`,
    pending: "answer it in T3",
  },
  "conversation-waiting": { what: (block) => `${block} asked a question` },
  "missing-report": { what: (block) => `${block}: report missing` },
  "execution-failed": { what: (block) => `${block}: execution failed` },
  "report-problem": { what: (block) => `${block}: report problem` },
  "condition-integrity": { what: (block) => `${block}: Condition cannot number its next arrival` },
  "settlement-unresolved": { what: () => "Settle could not stop workers" },
};

type MatterRow = {
  matter_id: string;
  kind: MatterKind;
  /** Null for a Run-level matter. */
  block: string | null;
  appeared_at: string;
  resolved: number;
};

type NoticeRow = {
  delivery_id: string;
  run_id: string;
  purpose: MatterNoticePurpose;
  state: DeliveryState;
  text: string;
  message_id: string | null;
  created_at: string;
  reference: string;
  title: string;
};

const matterLine = (matter: MatterRow) => {
  const kind = MATTERS[matter.kind];
  const what = kind.what(name(matter.block));
  if (matter.resolved === 1) return `• ~~${what}~~ ✅`;
  return `• ${what}${kind.pending ? ` — ${kind.pending}` : ""}`;
};

/** An attention notice's first line: an emoji for its kind of matters, the Run and what it has. */
function attentionHeading(heading: string, matters: readonly MatterRow[]) {
  const needsInput = matters.filter((matter) => NEEDS_INPUT.has(matter.kind)).length;
  const [emoji, subject] =
    needsInput === matters.length
      ? ["🙋", "needs input"]
      : needsInput === 0
        ? ["⚠️", matters.length === 1 ? "has a Problem" : "has Problems"]
        : ["🔔", "needs attention"];
  const resolved = matters.every((matter) => matter.resolved === 1) ? " · ✅ resolved" : "";
  return `${emoji} ${heading} ${subject}${resolved}`;
}

function noticeText(notice: NoticeRow, matters: readonly MatterRow[]) {
  const heading = runHeading(notice.reference, notice.title);
  const render = (limit: number) => {
    const lines = matters.slice(0, limit).map(matterLine);
    const rest = matters.length - lines.length;
    if (rest > 0) lines.push(`• and ${rest} more; the status card shows what is pending`);
    const first =
      notice.purpose === "attention"
        ? attentionHeading(heading, matters)
        : `📬 ${heading} · while Factory could not post in this thread:`;
    return [first, ...lines];
  };
  for (const limit of NOTICE_LIMITS) {
    const text = render(limit).join("\n");
    if (text.length <= NOTICE_TEXT_LIMIT) return text;
  }
  return clip(render(0).join("\n"), NOTICE_TEXT_LIMIT);
}

/**
 * The state a notice's message record moves to for `text`. A message that exists owes an edit
 * when its text changes, and a cancelled one is corrected silently once its channel grants the
 * Run again. A message never created that has nothing left to say retires: a matter resolved
 * before it was posted is not reported. Other states take the text.
 */
function nextState(notice: NoticeRow, text: string, obsolete: boolean): DeliveryState {
  if (notice.message_id !== null) {
    if (notice.state !== "delivered" && notice.state !== "cancelled") return notice.state;
    return notice.text === text ? "delivered" : "owed";
  }
  return obsolete && ["owed", "failed", "unknown"].includes(notice.state)
    ? "retired"
    : notice.state;
}

const NOTICE_COLUMNS = `n.delivery_id,n.run_id,d.purpose,d.state,d.text,d.message_id,d.created_at,r.reference,r.title`;

/** Brings one notice's message record to the text its current records render. */
const refreshNotice = (sql: SqlClient.SqlClient, id: string) =>
  Effect.gen(function* () {
    const [notice] = yield* sql<NoticeRow>`SELECT ${sql.literal(NOTICE_COLUMNS)}
      FROM chat_report_notices n JOIN chat_deliveries d ON d.id=n.delivery_id
      JOIN chat_run_reporting r ON r.run_id=n.run_id WHERE n.delivery_id=${id}`;
    const all = yield* sql<MatterRow>`SELECT matter_id,kind,block,appeared_at,resolved
      FROM chat_report_matters WHERE notice_id=${id} ORDER BY appeared_at,matter_id`;
    const announced = notice!.message_id !== null || notice!.state === "sending";
    const matters = announced ? all : all.filter((matter) => matter.resolved === 0);
    const obsolete = matters.length === 0;
    const text = obsolete ? notice!.text : noticeText(notice!, matters);
    const state = nextState(notice!, text, obsolete);
    if (state !== notice!.state)
      yield* sql`UPDATE chat_deliveries SET text=${text},state=${state},next_attempt_at=NULL,problem=NULL,problem_at=NULL WHERE id=${id}`;
    else if (text !== notice!.text)
      yield* sql`UPDATE chat_deliveries SET text=${text} WHERE id=${id}`;
  });

/** A notice message never created and not being sent: new content may still join it. */
const OPEN = "d.state='owed' AND d.message_id IS NULL";

export const reportNotices = (sql: SqlClient.SqlClient): ReportConsumer => {
  const insertNotice = (
    origin: ReportOrigin,
    report: RunReport,
    purpose: MatterNoticePurpose | "completion",
    text = "",
  ) =>
    Effect.gen(function* () {
      const id = yield* newId;
      const createdAt = yield* now;
      const { destination } = origin;
      yield* sql`INSERT INTO chat_deliveries (id,purpose,run_id,guild_id,parent_channel_id,thread_id,project_ids_json,text,state,created_at)
        VALUES (${id},${purpose},${origin.runId},${destination.guildId},${destination.parentChannelId},${destination.threadId},
          ${JSON.stringify([report.run.project.id])},${text},'owed',${createdAt})`;
      yield* sql`INSERT INTO chat_report_notices (delivery_id,run_id) VALUES (${id},${origin.runId})`;
      return id;
    });

  const insertMatters = (runId: string, noticeId: string | null, matters: readonly Matter[]) =>
    Effect.forEach(
      matters,
      (matter) =>
        sql`INSERT INTO chat_report_matters (matter_id,run_id,notice_id,kind,block,appeared_at)
          VALUES (${matter.id},${runId},${noticeId},${matter.kind},${matter.block},${matter.appearedAt})`,
      { discard: true },
    );

  /**
   * Announces new matters: they join a notice of the Run not posted yet while it has room,
   * otherwise new attention notices list them, at most a fixed number each. Returns the notices.
   */
  const announce = (origin: ReportOrigin, report: RunReport, fresh: readonly Matter[]) =>
    Effect.gen(function* () {
      const notices: string[] = [];
      let queue = fresh;
      const [open] = yield* sql<{ id: string; purpose: MatterNoticePurpose; count: number }>`
        SELECT d.id,d.purpose,(SELECT COUNT(*) FROM chat_report_matters m WHERE m.notice_id=d.id) AS count
        FROM chat_report_notices n JOIN chat_deliveries d ON d.id=n.delivery_id
        WHERE n.run_id=${origin.runId} AND ${sql.literal(OPEN)} AND d.purpose IN ('attention','catch-up')
        ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1`;
      if (open) {
        const room = open.purpose === "catch-up" ? queue.length : MATTERS_PER_NOTICE - open.count;
        yield* insertMatters(origin.runId, open.id, queue.slice(0, room));
        if (room > 0) notices.push(open.id);
        queue = queue.slice(room);
      }
      while (queue.length > 0) {
        const id = yield* insertNotice(origin, report, "attention");
        yield* insertMatters(origin.runId, id, queue.slice(0, MATTERS_PER_NOTICE));
        notices.push(id);
        queue = queue.slice(MATTERS_PER_NOTICE);
      }
      return notices;
    });

  /** Whether an Archived Run's notices owe nothing more, so later captures can skip it. */
  const finished = (runId: string) =>
    Effect.map(
      sql<{
        owing: number;
      }>`SELECT COUNT(*) AS owing FROM chat_report_notices n JOIN chat_deliveries d ON d.id=n.delivery_id
        WHERE n.run_id=${runId} AND (d.state IN ('owed','sending','failed','unknown')
          OR (d.state='cancelled' AND d.message_id IS NOT NULL))`,
      ([row]) => row!.owing === 0,
    );

  /**
   * Records how the Run is named now and returns whether this capture is a baseline: the first
   * capture after Start announces what is pending, the first after a regrant does not.
   */
  const accounting = (runId: string, report: RunReport) =>
    Effect.gen(function* () {
      const reference = runReference(report.run);
      const [row] = yield* sql<{
        baseline: number;
      }>`SELECT baseline FROM chat_run_reporting WHERE run_id=${runId}`;
      if (!row) {
        yield* sql`INSERT INTO chat_run_reporting (run_id,reference,title) VALUES (${runId},${reference},${report.run.title})`;
        return false;
      }
      yield* sql`UPDATE chat_run_reporting SET reference=${reference},title=${report.run.title} WHERE run_id=${runId}`;
      return row.baseline === 1;
    });

  const capturedCompletion = (origin: ReportOrigin, report: RunReport) =>
    Effect.gen(function* () {
      const [cycle] = yield* sql<{ sequence: number }>`SELECT c.sequence FROM chat_settled_cycles c
        JOIN chat_run_reporting r ON r.run_id=c.run_id
        JOIN chat_access_channel_projects g ON g.channel_id=${origin.destination.parentChannelId}
          AND g.project_id=${report.run.project.id}
        WHERE c.run_id=${origin.runId} AND r.completion_sequence IS NOT c.sequence`;
      if (!cycle) return;
      yield* insertNotice(
        origin,
        report,
        "completion",
        `✅ ${runHeading(runReference(report.run), report.run.title)} finished.\nReply here to inspect the result or choose what to do next.`,
      );
      yield* sql`UPDATE chat_run_reporting SET completion_sequence=${cycle.sequence} WHERE run_id=${origin.runId}`;
    });

  /**
   * Marks matters no longer pending resolved and records new ones: announced, or at a baseline
   * only shown on the card. Returns the notices whose text changed.
   */
  const capturedMatters = (origin: ReportOrigin, report: RunReport, baseline: boolean) =>
    Effect.gen(function* () {
      const pending = [...report.needsInput, ...report.problems];
      const pendingIds = new Set(pending.map((matter) => matter.id));
      const known = yield* sql<{
        matter_id: string;
        notice_id: string | null;
        resolved: number;
      }>`SELECT matter_id,notice_id,resolved FROM chat_report_matters WHERE run_id=${origin.runId}`;
      const resolved = known.filter(
        (matter) => matter.resolved === 0 && !pendingIds.has(matter.matter_id),
      );
      if (resolved.length > 0)
        yield* sql`UPDATE chat_report_matters SET resolved=1 WHERE matter_id IN ${sql.in(resolved.map((matter) => matter.matter_id))}`;
      const knownIds = new Set(known.map((matter) => matter.matter_id));
      const fresh = pending.filter((matter) => !knownIds.has(matter.id));
      const announced = baseline
        ? yield* Effect.as(insertMatters(origin.runId, null, fresh), [])
        : yield* announce(origin, report, fresh);
      return [...resolved.flatMap((matter) => matter.notice_id ?? []), ...announced];
    });

  /** Notice messages whose edits a revocation cancelled, corrected once the channel grants again. */
  const cancelledMessages = (runId: string) =>
    Effect.map(
      sql<{ delivery_id: string }>`SELECT n.delivery_id FROM chat_report_notices n
        JOIN chat_deliveries d ON d.id=n.delivery_id
        WHERE n.run_id=${runId} AND d.purpose IN ('attention','catch-up')
          AND d.state='cancelled' AND d.message_id IS NOT NULL`,
      (rows) => rows.map((row) => row.delivery_id),
    );

  return {
    capture: (origin, report) =>
      Effect.gen(function* () {
        if (!report) return;
        const { runId } = origin;
        const baseline = yield* accounting(runId, report);
        yield* capturedCompletion(origin, report);
        const touched = new Set(yield* capturedMatters(origin, report, baseline));
        if (baseline) yield* sql`UPDATE chat_run_reporting SET baseline=0 WHERE run_id=${runId}`;
        for (const id of yield* cancelledMessages(runId)) touched.add(id);
        for (const id of touched) yield* refreshNotice(sql, id);
        const final = report.run.state === "archived" && (yield* finished(runId));
        yield* sql`UPDATE chat_run_reporting SET final=${final ? 1 : 0} WHERE run_id=${runId}`;
      }),
  };
};

/** Merges a Run's never-created notices into one catch-up. */
const mergedCatchUp = (sql: SqlClient.SqlClient, notices: readonly NoticeRow[]) =>
  Effect.gen(function* () {
    const target = notices.find((notice) => notice.purpose === "catch-up") ?? notices[0]!;
    const others = notices
      .filter((notice) => notice !== target)
      .map((notice) => notice.delivery_id);
    if (others.length > 0) {
      yield* sql`UPDATE chat_report_matters SET notice_id=${target.delivery_id} WHERE notice_id IN ${sql.in(others)}`;
      yield* sql`DELETE FROM chat_report_notices WHERE delivery_id IN ${sql.in(others)}`;
      yield* sql`DELETE FROM chat_deliveries WHERE id IN ${sql.in(others)}`;
    }
    yield* sql`UPDATE chat_deliveries SET purpose='catch-up' WHERE id=${target.delivery_id}`;
    yield* refreshNotice(sql, target.delivery_id);
  });

/**
 * Coalesces what accrued while no session served into one catch-up per Run, when a session
 * starts serving: every notice of the Run never created merges into one, which reports its
 * pending matters. A notice whose message may exist, or that waits for the host's Retry, is left
 * as it is.
 */
export const catchUpNotices = (sql: SqlClient.SqlClient) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const unposted = yield* sql<NoticeRow>`SELECT ${sql.literal(NOTICE_COLUMNS)}
        FROM chat_report_notices n JOIN chat_deliveries d ON d.id=n.delivery_id
        JOIN chat_run_reporting r ON r.run_id=n.run_id
        WHERE d.message_id IS NULL AND d.state IN ('owed','failed','unknown')
          AND d.purpose IN ('attention','catch-up')
        ORDER BY d.created_at,d.rowid`;
      const byRun = new Map<string, NoticeRow[]>();
      for (const notice of unposted) {
        if (notice.state === "owed")
          byRun.set(notice.run_id, [...(byRun.get(notice.run_id) ?? []), notice]);
        else if (notice.text.length > NOTICE_TEXT_LIMIT)
          yield* refreshNotice(sql, notice.delivery_id);
      }
      for (const notices of byRun.values()) yield* mergedCatchUp(sql, notices);
    }),
  );
