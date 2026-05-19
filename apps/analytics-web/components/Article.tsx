/**
 * Article — optional editorial overlay rendered from content/articles/<kind>/<slug>.mdx.
 * Server component. When the article is missing, this renders nothing.
 */

import type { LoadedArticle } from '@/lib/article';
import { BookOpen } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function Article({ article }: { article: LoadedArticle | null }) {
  if (!article) return null;
  const fm = article.frontmatter as { title?: string; author?: string };
  return (
    <Card className="mt-8">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2 text-lg">
          <BookOpen className="size-4 text-primary" />
          {fm.title ?? 'Editorial'}
        </CardTitle>
        {fm.author ? (
          <p className="text-xs text-muted-foreground">By {fm.author}</p>
        ) : null}
      </CardHeader>
      <CardContent className="pt-6">
        <div className="text-[15px] leading-relaxed text-foreground/90 [&>h2]:mt-6 [&>h2]:mb-3 [&>h2]:text-base [&>h2]:font-semibold [&>h3]:mt-4 [&>h3]:mb-2 [&>h3]:font-semibold [&>p]:mb-3 [&>p:last-child]:mb-0 [&_strong]:font-semibold [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-mono [&_code]:text-xs [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5">
          {article.content}
        </div>
      </CardContent>
    </Card>
  );
}
