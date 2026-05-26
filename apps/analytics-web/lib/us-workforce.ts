/**
 * State-level total nonfarm employment, in thousands of workers. Used to
 * normalise H-1B filings to a "per 100k workers" view that surfaces dense
 * pockets (DC, NJ, MA) hidden by absolute volume.
 *
 * Source: BLS Local Area Unemployment Statistics (LAUS), annual averages
 * for the most recent full year available. Hard-coded here because it's
 * small (~50 entries), changes slowly, and we'd rather not add a third
 * data dependency for this page. Refresh annually by replacing the table.
 */

export const WORKFORCE_K: Readonly<Record<string, number>> = {
  AL: 2_120,  AK: 333,    AZ: 3_280,  AR: 1_310,  CA: 18_540,
  CO: 2_960,  CT: 1_720,  DE: 480,    DC: 800,    FL: 10_180,
  GA: 4_900,  HI: 660,    ID: 850,    IL: 6_140,  IN: 3_240,
  IA: 1_610,  KS: 1_460,  KY: 2_010,  LA: 1_970,  ME: 660,
  MD: 2_810,  MA: 3_770,  MI: 4_530,  MN: 3_010,  MS: 1_180,
  MO: 2_940,  MT: 510,    NE: 1_050,  NV: 1_510,  NH: 720,
  NJ: 4_310,  NM: 880,    NY: 9_900,  NC: 4_900,  ND: 440,
  OH: 5_640,  OK: 1_750,  OR: 1_960,  PA: 6_120,  RI: 510,
  SC: 2_320,  SD: 470,    TN: 3_290,  TX: 14_120, UT: 1_750,
  VT: 320,    VA: 4_240,  WA: 3_710,  WV: 720,    WI: 3_010,
  WY: 290,
  PR: 1_010,  GU: 60,     VI: 35,     AS: 17,     MP: 25,
};

/**
 * Returns filings per 100k workers, or null if the workforce figure is
 * missing for that state.
 */
export function perCapita(filings: number, code: string): number | null {
  const wf = WORKFORCE_K[code];
  if (!wf || wf <= 0) return null;
  // workforce is in thousands → multiply by 100 to get per 100k.
  return (filings / wf) * 100;
}
