import type { PathMapping } from "../config.ts";

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Audiobookshelf reports paths from inside its own container. This process may see the same
 * library at a different mount point, so paths are rewritten the way Sonarr/Radarr do it.
 * The longest matching prefix wins, so nested mappings behave predictably.
 */
export function mapAbsPathToLocal(absPath: string, mappings: PathMapping[]): string {
  if (!absPath) return absPath;
  const source = normalise(absPath);
  const candidates = [...mappings]
    .map((mapping) => ({ from: normalise(mapping.from), to: normalise(mapping.to) }))
    .filter((mapping) => mapping.from.length > 0)
    .sort((a, b) => b.from.length - a.from.length);

  for (const mapping of candidates) {
    if (source === mapping.from) return mapping.to;
    if (source.startsWith(`${mapping.from}/`)) {
      return `${mapping.to}${source.slice(mapping.from.length)}`;
    }
  }
  return source;
}

export function mapLocalPathToAbs(localPath: string, mappings: PathMapping[]): string {
  const inverted = mappings.map((mapping) => ({ from: mapping.to, to: mapping.from }));
  return mapAbsPathToLocal(localPath, inverted);
}
