/**
 * Archive directory helpers. Used by:
 *   - The /archive landing page to list available snapshots.
 *   - The /archive/[label]/... routes to validate the label early.
 *
 * The archives live next to the live DB at `data/archives/<label>.lca.db`,
 * one file per quarter, stamped by scripts/build-sqlite.ts after every
 * rebuild.
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR     = process.env.LCA_SQLITE_DIR ?? path.join(process.cwd(), 'data');
const ARCHIVES_DIR = path.join(DATA_DIR, 'archives');

const LABEL_RE = /^\d{4}-q[1-4]$/;

export interface ArchiveInfo {
  /** "2026-q1", "2025-q4", etc. */
  label: string;
  /** Display string like "FY2026 Q1". */
  display: string;
  /** Unix epoch seconds — file mtime, indicative of when the snapshot was generated. */
  generatedAt: number;
  /** Size in bytes. */
  bytes: number;
}

export function validateLabel(label: string): boolean {
  return LABEL_RE.test(label);
}

export function archiveExists(label: string): boolean {
  if (!validateLabel(label)) return false;
  return existsSync(path.join(ARCHIVES_DIR, `${label}.lca.db`));
}

/** Newest-first list of archive snapshots with metadata. */
export function listArchives(): ArchiveInfo[] {
  if (!existsSync(ARCHIVES_DIR)) return [];
  const out: ArchiveInfo[] = [];
  for (const file of readdirSync(ARCHIVES_DIR)) {
    if (!file.endsWith('.lca.db')) continue;
    const label = file.replace(/\.lca\.db$/, '');
    if (!validateLabel(label)) continue;
    const stat = statSync(path.join(ARCHIVES_DIR, file));
    out.push({
      label,
      display: labelToDisplay(label),
      generatedAt: Math.floor(stat.mtimeMs / 1000),
      bytes: stat.size,
    });
  }
  return out.sort((a, b) => b.label.localeCompare(a.label));
}

function labelToDisplay(label: string): string {
  // "2026-q1" → "2026 Q1"
  const [year, q] = label.split('-q');
  return `${year} Q${q}`;
}
