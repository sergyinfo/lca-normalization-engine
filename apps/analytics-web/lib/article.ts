/**
 * Optional MDX article loader.
 *
 * Each entity page can have a hand-authored article at:
 *   content/articles/<kind>/<slug>.mdx
 *
 * The page calls `loadArticle('employer', 'cognizant-...')`. If the file
 * exists, we compile it and return the rendered React node. If it doesn't,
 * we return null and the page silently skips the article block.
 *
 * Compilation uses next-mdx-remote/rsc (server-component-friendly). The
 * MDX file can use plain markdown plus any custom components we expose via
 * the `components` map below.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compileMDX } from 'next-mdx-remote/rsc';
import type { EntityKind } from './schema';

const CONTENT_ROOT = path.join(process.cwd(), 'content', 'articles');

export interface LoadedArticle {
  content: React.ReactNode;
  frontmatter: Record<string, unknown>;
}

export async function loadArticle(
  kind: EntityKind,
  slug: string,
): Promise<LoadedArticle | null> {
  const filePath = path.join(CONTENT_ROOT, kind, `${slug}.mdx`);
  let source: string;
  try {
    source = readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const { content, frontmatter } = await compileMDX<Record<string, unknown>>({
    source,
    options: { parseFrontmatter: true },
  });
  return { content, frontmatter };
}
