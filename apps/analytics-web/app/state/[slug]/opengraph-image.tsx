import { getStateBySlug, listAllStateSlugs } from '@/lib/queries';
import { fmt } from '@/lib/format';
import { renderEntityOg, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

export const alt = 'H-1B sponsorship by US state';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  return listAllStateSlugs().map((slug) => ({ slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = getStateBySlug(slug);
  if (!s) {
    return renderEntityOg({ eyebrow: 'US state', title: 'H-1B sponsorship', stats: [] });
  }
  return renderEntityOg({
    eyebrow: 'US state · H-1B sponsorship',
    title: `${s.name} (${s.code})`,
    accent: '#f87171',
    stats: [
      { label: 'Filings', value: fmt(s.filings) },
      { label: 'Rank',    value: `#${s.rank}` },
    ],
  });
}
