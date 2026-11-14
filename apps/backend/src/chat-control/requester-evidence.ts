/** Positive evidence captured when Factory admitted work; it stays current until invalidated. */
export interface EvidenceToken {
  readonly guildId: string;
  readonly connection: number;
  readonly guild: number;
}

/**
 * Factory's maintained proof of requesters' Discord access during one operating connection.
 * A token handed to later work is current only while no connection gap or observed permission
 * change in its server happened since. Private-thread membership is separately checked with
 * Discord on every use because the connection does not request the Server Members intent.
 */
export function makeRequesterEvidence() {
  let connection = 0;
  const guilds = new Map<string, number>();
  const changed = (guildId: string) => {
    guilds.set(guildId, (guilds.get(guildId) ?? 0) + 1);
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
    },
    /** A channel, thread, role or server changed in a way that can change anyone's access. */
    changed,
  };
}

export type RequesterEvidence = ReturnType<typeof makeRequesterEvidence>;
