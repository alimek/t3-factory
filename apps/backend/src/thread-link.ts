/** Native v2 pointers become browser links; stored receipts remain unchanged. */
export function threadHref(link: string | null) {
  const href = link?.replace(/^<(t3-thread:\/\/v[12]\/[^\s<>]+)>$/, "$1") ?? null;
  const native = href?.match(/^t3-thread:\/\/v2\/([^/\s<>]+)\/([^/\s<>]+)$/);
  return native ? scopedThreadHref(native[1]!, native[2]!) : href;
}

function hostedSegment(id: string) {
  return encodeURIComponent(id).replace(
    /[.!~*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** T3's hosted route opens the exact environment/thread from an external client. */
export function scopedThreadHref(environmentId: string, threadId: string) {
  return `https://app.t3.codes/threads/${hostedSegment(environmentId)}/${hostedSegment(threadId)}`;
}
