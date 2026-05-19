import { getSectorBySlug, listAllSectorSlugs } from '@/lib/queries';
import { fmt } from '@/lib/format';
import { renderEntityOg, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

export const alt = 'H-1B sponsorship by NAICS sector';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  return listAllSectorSlugs().map((slug) => ({ slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = getSectorBySlug(slug);
  if (!s) {
    return renderEntityOg({ eyebrow: 'NAICS sector', title: 'H-1B sponsorship', stats: [] });
  }
  return renderEntityOg({
    eyebrow: `NAICS sector ${s.naics2}`,
    title: s.label,
    accent: '#a78bfa',
    stats: [
      { label: 'Filings',   value: fmt(s.filings) },
      { label: 'Employers', value: fmt(s.employers) },
    ],
  });
}
