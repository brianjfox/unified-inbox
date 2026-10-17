/**
 * The design names every conversation row `conversation-<slug of name>`
 * ("Maria Chen" → `conversation-maria-chen`, "Alex, Jordan" →
 * `conversation-alex-jordan`). The slug is lower case ASCII letters and
 * digits joined by single dashes.
 */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A conversation whose name has no ASCII letters (an all-CJK name, an emoji)
 * would slug to nothing, so the row falls back to its service and id, which
 * are always ASCII.
 */
export function conversationSlug(name: string, service: string, conversationId: string): string {
  const s = slugify(name);
  return s.length > 0 ? s : slugify(`${service}-${conversationId}`);
}
