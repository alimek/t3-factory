/** Flows: the graphs of Blocks that Runs execute. */
/** A named result a Block finishes with. Wires leave by `id`, so renaming keeps them. */
export interface BlockExit {
  readonly id: string;
  readonly name: string;
  /** Empty when the exit has no description. */
  readonly description: string;
  /** Finishing on this exit needs a non-empty message. */
  readonly messageRequired: boolean;
}
