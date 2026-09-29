/** Helpers for turning sender-supplied file names into safe local names. */

/** Strip path separators and control characters from a sender-supplied name. */
export function sanitizeName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned.slice(0, 255) || 'file';
}

/** `a.txt, a.txt` → `a.txt, a (1).txt` (zip entries must be unique). */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((name) => {
    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      return name;
    }
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; ; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!seen.has(candidate.toLowerCase())) {
        seen.add(candidate.toLowerCase());
        return candidate;
      }
    }
  });
}
