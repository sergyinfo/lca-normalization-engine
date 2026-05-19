import Link from 'next/link';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="size-16 rounded-full bg-secondary flex items-center justify-center text-primary mb-6">
        <Compass className="size-8" />
      </div>
      <h1 className="text-3xl md:text-4xl font-bold tracking-tight">404 — Not found</h1>
      <p className="text-muted-foreground mt-3 max-w-md">
        That entity isn&rsquo;t in our current data slice. The launch slice
        covers ~150 curated entities; broader coverage rolls out each quarter.
      </p>
      <div className="flex gap-3 mt-6">
        <Button asChild>
          <Link href="/">Back to home</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/search">Search</Link>
        </Button>
      </div>
    </div>
  );
}
