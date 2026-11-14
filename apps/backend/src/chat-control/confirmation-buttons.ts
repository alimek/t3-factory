import { ButtonStyle, ComponentType } from "discord.js";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { now } from "../time.ts";
import { channelGrants, wakeableLoop, type DiscordSender } from "./deliveries.ts";

export const BUTTON_PREFIX = "factory-confirm:";

/** How a review's button shows once it can no longer be used, and why. */
const DISABLED_LABELS = {
  confirmed: "✅ Confirmed",
  expired: "⌛ Expired",
  replaced: "↩️ Replaced",
  invalid: "🚫 No longer valid",
} as const;
export type DisabledButton = keyof typeof DISABLED_LABELS;

/** A requester-bound confirmation button, live or disabled. */
export interface ConfirmationButton {
  readonly customId: string;
  readonly label: string;
}

/** The single action row a review's last message carries: live, or disabled with a reason. */
export const buttonRow = (
  customId: string,
  button: { readonly label: string } | { readonly disabled: DisabledButton },
) => [
  {
    type: ComponentType.ActionRow,
    components: [
      "label" in button
        ? {
            type: ComponentType.Button,
            style: ButtonStyle.Primary,
            label: button.label,
            custom_id: customId,
          }
        : {
            type: ComponentType.Button,
            style: button.disabled === "confirmed" ? ButtonStyle.Success : ButtonStyle.Secondary,
            label: DISABLED_LABELS[button.disabled],
            custom_id: customId,
            disabled: true,
          },
    ],
  },
];

/** A Discord edit is abandoned after this long; the button simply stays as it was. */
const EDIT_TIMEOUT = Duration.seconds(10);

type DueRow = {
  id: string;
  parent_channel_id: string;
  guild_id: string;
  thread_id: string;
  project_ids_json: string;
  button_message_id: string;
  state: "presented" | "ended";
  ended_reason: "superseded" | "revoked" | null;
};

/**
 * Best-effort visual retirement of review buttons that can no longer confirm anything: expired at
 * their original expiry, superseded by a correction, or voided by an Access revocation. Each
 * button gets one edit attempt from the serving session of the application that posted it, only
 * while its channel still grants the review's Projects; failures are ignored and never become
 * delivery problems. A review that expired while no session served, or that an Access save voided
 * while Chat control was Off, keeps its button as it is: nothing is sent for Off. Eligibility never depends on this; clicks are always
 * decided by the review's own state.
 */
export const confirmationButtons = (sql: SqlClient.SqlClient) => {
  const loop = wakeableLoop();

  const due = (applicationId: string, at: string) =>
    sql<DueRow>`SELECT id,guild_id,parent_channel_id,thread_id,project_ids_json,button_message_id,state,ended_reason
      FROM chat_proposals WHERE application_id=${applicationId} AND button_settled=0 AND button_message_id IS NOT NULL
        AND ((state='ended' AND ended_reason IN ('superseded','revoked')) OR (state='presented' AND expires_at<=${at}))
      ORDER BY created_at,rowid`;

  const retire = (sender: DiscordSender, row: DueRow) =>
    Effect.gen(function* () {
      const claimed =
        yield* sql`UPDATE chat_proposals SET button_settled=1 WHERE id=${row.id} AND button_settled=0 RETURNING id`;
      if (claimed.length === 0) return;
      const granted = yield* channelGrants(sql, row.parent_channel_id);
      if ((JSON.parse(row.project_ids_json) as string[]).some((id) => !granted.has(id))) return;
      const state: DisabledButton =
        row.state === "presented"
          ? "expired"
          : row.ended_reason === "superseded"
            ? "replaced"
            : "invalid";
      yield* Effect.tryPromise(() =>
        sender.disable(
          {
            guildId: row.guild_id,
            parentChannelId: row.parent_channel_id,
            threadId: row.thread_id,
          },
          row.button_message_id,
          `${BUTTON_PREFIX}${row.id}`,
          state,
        ),
      ).pipe(Effect.timeoutOption(EDIT_TIMEOUT), Effect.ignore);
    });

  /** The serving session's retirement loop; it ends with the session's scope. */
  const serve = (sender: DiscordSender) =>
    Effect.gen(function* () {
      const startedAt = yield* now;
      yield* sql`UPDATE chat_proposals SET button_settled=1 WHERE button_settled=0 AND button_message_id IS NOT NULL
        AND state='presented' AND expires_at<=${startedAt}`;
      return yield* loop.run(
        Effect.gen(function* () {
          const at = yield* now;
          for (const row of yield* due(sender.applicationId, at)) yield* retire(sender, row);
          // The next live button's expiry is when one may become unusable on its own.
          const [next] = yield* sql<{
            expires_at: string | null;
          }>`SELECT MIN(expires_at) AS expires_at
            FROM chat_proposals WHERE application_id=${sender.applicationId} AND button_settled=0
              AND button_message_id IS NOT NULL AND state='presented'`;
          return next?.expires_at ?? null;
        }),
      );
    });

  return {
    serve,
    /** A review may have become unusable; the serving session looks now. */
    changed: Effect.sync(loop.wake),
  };
};
