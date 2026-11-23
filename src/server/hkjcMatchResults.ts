/**
 * Server-only: fetch official FT from HKJC GraphQL `matchResults`.
 *
 * Do not use GET https://info.cld.hkjc.com/ (403).
 * POST https://info.cld.hkjc.com/graphql/base/ with JSON + Chrome UA +
 * Referer/Origin bet.hkjc.com.
 *
 * Pagination: endIndex - startIndex must be ≤ 20 or HKJC returns 0 rows
 * (verified 2026-11-23). Page with start += 20, dedupe by match.id.
 *
 * Date filter YYYY-MM-DD is accepted by matchResults (unlike matchList).
 */

import {
  isVoidHkjcStatus,
  pickOfficialFt,
  type HkjcResultRow,
  type OfficialFtScore,
} from '../math/officialFt.ts';

export const HKJC_GRAPHQL_URL = 'https://info.cld.hkjc.com/graphql/base/';
export const HKJC_RESULTS_PAGE = 20;

export const MATCH_RESULTS_QUERY = "\n    query matchResults($startDate: String, $endDate: String, $startIndex: Int,$endIndex: Int,$teamId: String) {\n      matchNumByDate(startDate: $startDate, endDate: $endDate, teamId: $teamId) {\n        total\n      }\n      matches: matchResult(startDate: $startDate, endDate: $endDate, startIndex: $startIndex,endIndex: $endIndex, teamId: $teamId) {\n        id\n        status\n        frontEndId\n        matchDayOfWeek\n        matchNumber\n        matchDate\n        kickOffTime\n        sequence\n        homeTeam {\n          id\n          name_en\n          name_ch\n        }\n        awayTeam {\n          id\n          name_en\n          name_ch\n        }\n        tournament {\n          code\n          name_en\n          name_ch      \n        }\n        results {\n          homeResult\n          awayResult\n          ttlCornerResult\n          resultConfirmType\n          payoutConfirmed\n          stageId\n          resultType\n          sequence\n        }\n        poolInfo {\n          payoutRefundPools\n          refundPools\n          ntsInfo\n          entInfo\n          definedPools\n          ngsInfo {\n            str\n            name_en\n            name_ch\n            instNo\n          }\n          agsInfo {\n            str\n            name_en\n            name_ch\n            }\n        }\n      }\n    }\n  "

export type HkjcFinishedMatch = {
  id: string;
  status: string;
  frontEndId?: string | null;
  kickOffTime?: string | null;
  homeNameZh?: string | null;
  awayNameZh?: string | null;
  officialFt: OfficialFtScore | null;
  voided: boolean;
};

export type FetchMatchResultsInput = {
  startDate: string; // YYYY-MM-DD (HKT calendar date)
  endDate: string;
  fetchImpl?: typeof fetch;
};

const HKJC_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://bet.hkjc.com/football/',
  Origin: 'https://bet.hkjc.com',
};

type RawMatch = {
  id?: string;
  status?: string;
  frontEndId?: string | null;
  kickOffTime?: string | null;
  homeTeam?: { name_ch?: string };
  awayTeam?: { name_ch?: string };
  results?: HkjcResultRow[] | null;
};

async function postPage(
  startDate: string,
  endDate: string,
  startIndex: number,
  endIndex: number,
  fetchImpl: typeof fetch,
): Promise<{ total: number; matches: RawMatch[] }> {
  const res = await fetchImpl(HKJC_GRAPHQL_URL, {
    method: 'POST',
    headers: HKJC_HEADERS,
    body: JSON.stringify({
      operationName: 'matchResults',
      query: MATCH_RESULTS_QUERY,
      variables: { startDate, endDate, startIndex, endIndex, teamId: null },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`hkjc_matchResults_http_${res.status}`);
  const data = (await res.json()) as {
    errors?: { message?: string }[];
    data?: { matchNumByDate?: { total?: number }; matches?: RawMatch[] };
  };
  if (Array.isArray(data.errors) && data.errors.length) {
    throw new Error(`hkjc_matchResults_gql:${data.errors[0]?.message || 'error'}`);
  }
  return {
    total: Number(data.data?.matchNumByDate?.total ?? 0),
    matches: Array.isArray(data.data?.matches) ? data.data!.matches! : [],
  };
}

export function mapRawFinishedMatch(raw: RawMatch): HkjcFinishedMatch | null {
  const id = String(raw.id || '');
  if (!id) return null;
  const status = String(raw.status || '');
  return {
    id,
    status,
    frontEndId: raw.frontEndId ?? null,
    kickOffTime: raw.kickOffTime ?? null,
    homeNameZh: raw.homeTeam?.name_ch ?? null,
    awayNameZh: raw.awayTeam?.name_ch ?? null,
    officialFt: pickOfficialFt(raw.results),
    voided: isVoidHkjcStatus(status),
  };
}

/**
 * Page through matchResults for [startDate, endDate] inclusive.
 * Dedupes by id. Stops when a page is empty or unique count reaches total.
 */
export async function fetchHkjcMatchResults(
  input: FetchMatchResultsInput,
): Promise<HkjcFinishedMatch[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const out: HkjcFinishedMatch[] = [];
  const seen = new Set<string>();
  let start = 0;
  let total = Infinity;
  const maxPages = 80; // 20 * 80 = 1600 rows, above settled cap
  for (let page = 0; page < maxPages && start < total; page += 1) {
    const { total: t, matches } = await postPage(
      input.startDate,
      input.endDate,
      start,
      start + HKJC_RESULTS_PAGE,
      fetchImpl,
    );
    if (Number.isFinite(t) && t >= 0) total = t;
    if (!matches.length) break;
    let added = 0;
    for (const raw of matches) {
      const mapped = mapRawFinishedMatch(raw);
      if (!mapped || seen.has(mapped.id)) continue;
      seen.add(mapped.id);
      out.push(mapped);
      added += 1;
    }
    if (added === 0) break;
    start += HKJC_RESULTS_PAGE;
  }
  return out;
}

/** HKT calendar date YYYY-MM-DD from an ISO (or +08:00) timestamp, or Date. */
export function hktDateString(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function resultsDateRangeForPending(
  pendingStarts: string[],
  now = new Date(),
): { startDate: string; endDate: string } | null {
  const today = hktDateString(now);
  const dates = pendingStarts.map(hktDateString).filter(Boolean).sort();
  if (!dates.length) return { startDate: today, endDate: today };
  return { startDate: dates[0]!, endDate: today < dates[dates.length - 1]! ? dates[dates.length - 1]! : today };
}
