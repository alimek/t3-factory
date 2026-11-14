import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** An Access save's channels and the Projects each grants. */
type Channels = readonly { readonly channelId: string; readonly projectIds: readonly string[] }[];

/** Whether `channels` no longer let `parentChannelId` reach every one of `projectIdsJson`. */
const ungranted = (channels: Channels, parentChannelId: string, projectIdsJson: string) => {
  const channel = channels.find((entry) => entry.channelId === parentChannelId);
  return (
    !channel ||
    (JSON.parse(projectIdsJson) as string[]).some((id) => !channel.projectIds.includes(id))
  );
};

/**
 * What an Access save revokes, applied inside its transaction. Live proposals of a requester no
 * longer allowed, or whose channel is gone or no longer grants a Project they target, end for good:
 * a regrant revives nothing. Undelivered messages to a destination that no longer grants their
 * Projects are cancelled; a message already being sent may finish, and the action it reports stays
 * recorded.
 */
export const applyAccessRevocation = (
  sql: SqlClient.SqlClient,
  access: { readonly users: readonly string[]; readonly channels: Channels },
) =>
  Effect.gen(function* () {
    const live = yield* sql<{
      id: string;
      requester_id: string;
      parent_channel_id: string;
      project_ids_json: string;
    }>`SELECT id,requester_id,parent_channel_id,project_ids_json FROM chat_proposals WHERE state IN ('preparing','presented')`;
    const voided = live.filter(
      (row) =>
        !access.users.includes(row.requester_id) ||
        ungranted(access.channels, row.parent_channel_id, row.project_ids_json),
    );
    if (voided.length > 0)
      yield* sql`UPDATE chat_proposals SET state='ended',ended_reason='revoked' WHERE id IN ${sql.in(voided.map((row) => row.id))}`;
    const owed = yield* sql<{
      id: string;
      parent_channel_id: string;
      project_ids_json: string;
    }>`SELECT id,parent_channel_id,project_ids_json FROM chat_deliveries WHERE state IN ('owed','failed','unknown')`;
    const cancelled = owed.filter((row) =>
      ungranted(access.channels, row.parent_channel_id, row.project_ids_json),
    );
    if (cancelled.length > 0)
      yield* sql`UPDATE chat_deliveries SET state='cancelled',next_attempt_at=NULL WHERE id IN ${sql.in(cancelled.map((row) => row.id))}`;
  });

/**
 * Retires the live proposals of an application being replaced: its buttons can never confirm
 * again, even if that application is configured again later. Owed receipts stay owed. Call inside
 * the connection save.
 */
export const retireApplicationProposals = (sql: SqlClient.SqlClient, applicationId: string) =>
  sql`UPDATE chat_proposals SET state='ended',ended_reason='application'
    WHERE application_id=${applicationId} AND state IN ('preparing','presented')`;
