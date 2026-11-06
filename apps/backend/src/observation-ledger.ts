/** Closed Run presentation preflight retains new safety references only for this fresh scan. */
export function observationLedger<A>(readSaved: () => Promise<readonly A[]>) {
  const observed = new Map<string, A>();
  return {
    async read(): Promise<readonly A[]> {
      const rows = new Map((await readSaved()).map((row) => [JSON.stringify(row), row]));
      return [...new Map([...rows, ...observed]).values()];
    },
    async retain(rows: readonly A[]) {
      for (const row of rows) observed.set(JSON.stringify(row), row);
    },
  };
}
