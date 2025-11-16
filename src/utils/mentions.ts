export function extractMentionsFromContent(content: string): string[] {
  if (!content) {
    return [];
  }
  const matches = content.match(/@([a-zA-Z0-9._\-]+)/g);
  if (!matches) {
    return [];
  }
  const unique = new Set<string>();
  matches.forEach(match => {
    const id = match.slice(1).trim();
    if (id) {
      unique.add(id);
    }
  });
  return Array.from(unique);
}
