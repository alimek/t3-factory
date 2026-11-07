const TEXT_LIMIT = 262_144;

type TextItem = {
  readonly itemId: string;
  readonly text: string | null;
  readonly textTruncated?: boolean;
  readonly nextTextOffset?: number | null;
};

/** Follow a truncated activity item until its text is complete. An inconsistent continuation throws. */
export async function completeDynamicToolText<T extends TextItem>(
  item: T,
  read: (itemId: string, textOffset: number) => Promise<T>,
): Promise<T> {
  if (item.textTruncated !== true) return item;
  let text = slice(item, true);
  let offset = item.nextTextOffset;
  if (offset !== text.length) throw Error("Activity text has no usable continuation.");
  for (let chunks = 0; chunks < 100; chunks++) {
    const part = await read(item.itemId, offset);
    if (part.itemId !== item.itemId) throw Error("Activity continuation changed item identity.");
    text += slice(part, part.textTruncated === true);
    if (text.length > TEXT_LIMIT) throw Error("Activity text exceeds the 262144-character limit.");
    if (part.textTruncated !== true) {
      if (part.nextTextOffset !== null && part.nextTextOffset !== undefined)
        throw Error("Activity continuation metadata is inconsistent.");
      return { ...item, text, textTruncated: false, nextTextOffset: null };
    }
    if (part.nextTextOffset !== text.length)
      throw Error("Activity text has no usable continuation.");
    offset = part.nextTextOffset;
  }
  throw Error("Activity text continuation limit exceeded.");
}

function slice(item: TextItem, mustAdvance: boolean): string {
  if (typeof item.text !== "string" || (mustAdvance && item.text.length === 0))
    throw Error("Activity text has no usable continuation.");
  return item.text;
}
