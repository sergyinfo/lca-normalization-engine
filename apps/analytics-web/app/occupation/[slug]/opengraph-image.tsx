import { getOccupationBySlug, listAllOccupationSlugs } from '@/lib/queries';
import { fmt, fmtUsd } from '@/lib/format';
import { renderEntityOg, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

export const alt = 'H-1B occupation salary guide';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  return listAllOccupationSlugs().map((slug) => ({ slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const o = getOccupationBySlug(slug);
  if (!o) {
    return renderEntityOg({ eyebrow: 'Occupation', title: 'Salary guide', stats: [] });
  }
  return renderEntityOg({
    eyebrow: `SOC ${o.soc_code} · H-1B salary guide`,
    title: o.soc_title ?? o.soc_code,
    accent: '#34d399',
    stats: [
      { label: 'Median wage', value: fmtUsd(o.p50_wage) },
      { label: 'Filings',     value: fmt(o.filings) },
      { label: 'P75',         value: fmtUsd(o.p75_wage) },
    ],
  });
}
