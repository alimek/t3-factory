/** Positive evidence captured when Factory admitted work; it stays current until invalidated. */
export interface EvidenceToken {
  readonly guildId: string;
  readonly connection: number;
  readonly guild: number;
}

/**
 * Factory's maintained proof of requesters' Discord access during one operating connection.
 * Membership of private threads is remembered only from positive observations; every connection
 * gap forgets all of it, and membership or permission changes forget what they could affect. A
 * token handed to later work is current only while no gap or change in its server happened since,
 * so stale, absent or ambiguous evidence denies rather than grants.
 */
export function makeRequesterEvidence() {
  let connection = 0;
  const guilds = new Map<string, number>();
  /** Private-thread memberships seen this connection, as `thread:user` → server. */
  const members = new Map<string, string>();
  const key = (threadId: string, userId: string) => `${threadId}:${userId}`;
  const changed = (guildId: string) => {
    guilds.set(guildId, (guilds.get(guildId) ?? 0) + 1);
    for (const [member, guild] of members) if (guild === guildId) members.delete(member);
  };
  return {
    token: (guildId: string): EvidenceToken => ({
      guildId,
      connection,
      guild: guilds.get(guildId) ?? 0,
    }),
    isCurrent: (token: EvidenceToken) =>
      token.connection === connection && token.guild === (guilds.get(token.guildId) ?? 0),
    /** The Gateway connection was interrupted: events may have been missed. */
    gap: () => {
      connection += 1;
      members.clear();
    },
    /** A channel, thread, role or server changed in a way that can change anyone's access. */
    changed,
    /** Someone left or was removed from a thread. */
    left: (guildId: string, threadId: string, userIds: readonly string[]) => {
      guilds.set(guildId, (guilds.get(guildId) ?? 0) + 1);
      for (const userId of userIds) members.delete(key(threadId, userId));
    },
    /** Discord showed the user inside the private thread (their message or a membership event). */
    joined: (guildId: string, threadId: string, userId: string) => {
      members.set(key(threadId, userId), guildId);
    },
    isMember: (threadId: string, userId: string) => members.has(key(threadId, userId)),
  };
}

export type RequesterEvidence = ReturnType<typeof makeRequesterEvidence>;
