/**
 * PitchEdge — official FT (法定全場) extraction and HKJC status mapping.
 *
 * Live matchList (odds / boards) drops finished matches after HKJC closes
 * the market. Official scores for booking MUST come from GraphQL
 * `matchResults` (paged, page window ≤ 20), not from live/HT runningResult.
 *
 * No Math.random. No invented scores.
 */

import { settleFtOnly, type MatchPhase } from './learn.ts';

/** HKJC `results[]` row from `matchResults`. */
export type HkjcResultRow = {
  homeResult?: number | null;
  awayResult?: number | null;
  ttlCornerResult?: number | null;
  resultConfirmType?: number | null;
  payoutConfirmed?: boolean | null;
  stageId?: number | null;
  resultType?: number | null;
  sequence?: number | null;
};

export type OfficialFtScore = {
  home: number;
  away: number;
  /** Regular-time FT stage used (5 or 100). */
  stageId: number;
  official: true;
  finished: true;
};

/**
 * HKJC stageId (from live SPA / inventory, not guessed):
 * - 2–5: regular-time running score
 * - 3: typically end of first half (HT) — MUST NOT book as 法定全場
 * - 5: end of regular time (法定全場)
 * - 6–9: extra time (`runningResultExtra`) — MUST NOT book as 法定全場
 * - 100: confirmed final display score (use as FT fallback)
 *
 * Confirmed row filter used by HKJC SPA:
 *   resultType==1 && resultConfirmType>1 && payoutConfirmed && home/away > -1
 * We further require stageId 5 or 100 so HT (3) and ET (9) cannot settle.
 */
export const OFFICIAL_FT_STAGE_IDS = [5, 100] as const;
export const HT_STAGE_IDS = [3] as const;
export const ET_STAGE_IDS = [6, 7, 8, 9] as const;

export const HKJC_POST_STATUSES = new Set([
  'MATCHENDED',
  'INPLAYMATCHENDED',
]);

export const HKJC_VOID_STATUSES = new Set([
  'MATCHVOIDED',
  'ABANDONED',
  'CANCELLED',
  'POSTPONED',
]);

export const HKJC_IN_STATUSES = new Set([
  'FIRSTHALF',
  'FIRSTHALFCOMPLETED',
  'HALFTIME',
  'SECONDHALF',
  'SECONDHALFCOMPLETED',
  'EXTRAFTIME',
  'EXTRATIME',
  'EXTRATIMEFIRSTHALF',
  'EXTRATIMESECONDHALF',
  'PENALTYSHOOTOUT',
  'LIVE',
  'INPLAY',
]);

export type BoardState = 'pre' | 'in' | 'post';

export function isValidScore(home: unknown, away: unknown): boolean {
  return (
    home != null &&
    away != null &&
    Number.isFinite(Number(home)) &&
    Number.isFinite(Number(away)) &&
    Number(home) >= 0 &&
    Number(away) >= 0
  );
}

function isConfirmedGoalRow(row: HkjcResultRow): boolean {
  if (row.resultType !== 1) return false;
  if (row.payoutConfirmed !== true) return false;
  if (row.resultConfirmType == null || Number(row.resultConfirmType) <= 1) return false;
  return isValidScore(row.homeResult, row.awayResult);
}

/**
 * Pick 法定全場 goals from matchResults.results[].
 * Returns null for HT-only, ET-only, unconfirmed, or missing scores.
 */
export function pickOfficialFt(results: HkjcResultRow[] | null | undefined): OfficialFtScore | null {
  if (!Array.isArray(results) || results.length === 0) return null;
  const confirmed = results.filter(isConfirmedGoalRow);
  if (!confirmed.length) return null;

  const prefer = (ids: readonly number[]): HkjcResultRow | null => {
    const rows = confirmed.filter((r) => ids.includes(Number(r.stageId)));
    if (!rows.length) return null;
    // Highest sequence is the latest confirmed write for that stage.
    return [...rows].sort((a, b) => Number(b.sequence ?? 0) - Number(a.sequence ?? 0))[0] ?? null;
  };

  const row = prefer([5]) ?? prefer([100]);
  if (!row) return null; // HT (3) or ET (9) only — do not book

  return {
    home: Number(row.homeResult),
    away: Number(row.awayResult),
    stageId: Number(row.stageId),
    official: true,
    finished: true,
  };
}

/** True when we may call settleFtOnly / book a review row. */
export function mayBookOfficialFt(score: OfficialFtScore | null | undefined): boolean {
  if (!score) return false;
  const gate = settleFtOnly({
    phase: 'ft',
    homeScore: score.home,
    awayScore: score.away,
  });
  return gate.maySettle && gate.mayApplyLearn;
}

/**
 * Map an HKJC matchList / matchResults status onto the board state.
 * runningResult during FIRSTHALF/SECONDHALF is live/HT — never officialFt.
 */
export function mapHkjcStatusToBoard(status: string | null | undefined): BoardState {
  const s = String(status || '').trim().toUpperCase();
  if (!s || s === 'PREEVENT') return 'pre';
  if (HKJC_POST_STATUSES.has(s)) return 'post';
  if (HKJC_VOID_STATUSES.has(s)) return 'post'; // post, but caller must not book void
  if (HKJC_IN_STATUSES.has(s)) return 'in';
  // Unknown in-play-ish tokens default to in so we never book them as FT.
  if (s.includes('HALF') || s.includes('LIVE') || s.includes('PLAY') || s.includes('EXTRA') || s.includes('PEN')) {
    return 'in';
  }
  return 'pre';
}

export function isVoidHkjcStatus(status: string | null | undefined): boolean {
  return HKJC_VOID_STATUSES.has(String(status || '').trim().toUpperCase());
}

/**
 * Board officialFt field: only when HKJC status is a finished (non-void)
 * match AND pickOfficialFt succeeded. Never copy live/HT runningResult here.
 */
export function officialFtForBoard(input: {
  status: string | null | undefined;
  results?: HkjcResultRow[] | null;
}): OfficialFtScore | null {
  if (isVoidHkjcStatus(input.status)) return null;
  if (mapHkjcStatusToBoard(input.status) !== 'post') return null;
  const ft = pickOfficialFt(input.results);
  return mayBookOfficialFt(ft) ? ft : null;
}

export type LivePhase = MatchPhase;

/** Phase implied by board state + officialFt (for settleFtOnly). */
export function phaseForBoardMatch(input: {
  state: BoardState;
  officialFt?: { home: number; away: number } | null;
}): MatchPhase {
  if (input.officialFt && isValidScore(input.officialFt.home, input.officialFt.away)) return 'ft';
  if (input.state === 'post') return 'ft';
  if (input.state === 'in') return 'live';
  if (input.state === 'pre') return 'pre';
  return 'unknown';
}
