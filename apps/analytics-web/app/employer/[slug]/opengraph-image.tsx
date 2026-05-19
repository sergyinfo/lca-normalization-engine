import { getEmployer, listAllEmployerSlugs } from '@/lib/queries';
import { fmt, fmtPct } from '@/lib/format';
import { renderEntityOg, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

export const alt = 'H-1B sponsor profile';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  return listAllEmployerSlugs().map((slug) => ({ slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const e = getEmployer(slug);
  if (!e) {
    return renderEntityOg({
      eyebrow: 'H-1B sponsor',
      title: 'Profile',
      stats: [],
    });
  }
  return renderEntityOg({
    eyebrow: 'H-1B sponsor',
    title: e.canonical_name,
    accent: '#38bdf8',
    stats: [
      { label: 'Filings',    value: fmt(e.filings) },
      { label: 'Certified',  value: fmtPct(e.certified_pct, 1) },
      { label: 'Rank',       value: `#${e.rank}` },
    ],
  });
}
