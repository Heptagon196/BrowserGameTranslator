export function extractPlaceholders(value: string): string[] {
  return Array.from(
    new Set([
      ...(value.match(/\{[^{}\s]+\}/g) ?? []),
      ...(value.match(/%\d+/g) ?? []),
      ...(value.match(/\\[A-Za-z]+\[\d+\]/g) ?? []),
      ...(value.match(/\{\{[^{}]+\}\}/g) ?? [])
    ])
  );
}

export function extractHtmlTags(value: string): string[] {
  return Array.from(new Set(value.match(/<\/?[a-z][^>]*>/gi) ?? []));
}

export function numericPrefix(value: string): string | null {
  return value.match(/^\s*(\d+[.)、:：-])/)?.[1] ?? null;
}
