/**
 * PitchEdge live 覆核帳本 — shared-ledger merge, seed, trim, ingest, booking.
 *
 * This is the format the published app actually exports (2026-11-22):
 *   { format: "pitchedge-review-backup", version: 1, exportedAt, items, settledNByKey }
 *
 * Stable row id is `item.key` (league:matchId). Do NOT include settledAt —
 * the live review-page helper `k()` does, which would treat a pending row and
 * its later settlement as two rows and let stale pending linger.
 *
 * No Math.random. No invented fixtures or scores.
 */

import { buildLearnKey, settleFtOnly } from './learn.ts';
import {
  isValidScore,
  mayBookOfficialFt,
  type OfficialFtScore,
} from './officialFt.ts';

export const REVIEW_BACKUP_FORMAT = 'pitchedge-review-backup' as const;
export const REVIEW_BACKUP_VERSION = 1 as const;

export const SETTLED_CAP = 800;
export const UNSTARTED_PENDING_CAP = 200;

export const PICK_MARKETS = ['1x2', 'ah', 'ou', 'btts', 'cs'] as const;
export const RESULT_VALUES = ['win', 'half', 'push', 'halfLoss', 'loss', 'pending'] as const;

export type PickMarket = (typeof PICK_MARKETS)[number];
export type ReviewResult = (typeof RESULT_VALUES)[number];
export type ReviewSource = 'live' | 'rebuild';
export type DataQuality = 'thin' | 'fair' | 'solid';

export type ReviewPick = {
  market: string;
  selection: string;
  selectionLabel: string;
  probability: number;
  fairOdds: number;
  marketDecimal: number | null;
  edge: number | null;
  confidence: number;
  stake: number | null;
  note: string;
};

export type ReviewItem = {
  key: string;
  league: string;
  leagueNameZh: string;
  matchId: string;
  home: string;
  away: string;
  homeLogo: string | null;
  awayLogo: string | null;
  start: string;
  source: ReviewSource;
  capturedAt: number;
  hkjcId: string | null;
  pick: ReviewPick;
  quality: DataQuality;
  ouLine: number;
  ahLine: number;
  pHome: number;
  pDraw: number;
  pAway: number;
  pOver: number;
  pBtts: number;
  pAhHome: number;
  homeScore: number | null;
  awayScore: number | null;
  ftOfficial: boolean;
  settledAt: number | null;
  result: ReviewResult;
  units: number | null;
  hit: number | null;
  favouriteSelection: string | null;
};

export type ReviewLedger = {
  items: ReviewItem[];
  settledNByKey: Record<string, number>;
};

export type ReviewBackupFile = {
  format: typeof REVIEW_BACKUP_FORMAT;
  version: typeof REVIEW_BACKUP_VERSION;
  exportedAt: string;
  items: ReviewItem[];
  settledNByKey: Record<string, number>;
};

export type MergeMode = 'merge' | 'replace';

export type BoardPickModel = {
  pick: ReviewPick;
  dataQuality?: DataQuality;
  ouLine?: number;
  ahLine?: number;
  pHome?: number;
  pDraw?: number;
  pAway?: number;
  pOver?: number;
  pBtts?: number;
  pAhHome?: number;
};

export type BoardMatch = {
  league: string;
  id: string;
  leagueNameZh?: string;
  start: string;
  state: 'pre' | 'in' | 'post';
  officialFt?: { home: number; away: number } | null;
  home: { nameZh?: string; name?: string; logo?: string | null; score?: number | null };
  away: { nameZh?: string; name?: string; logo?: string | null; score?: number | null };
  hkjc?: { id?: string | null; frontEndId?: string | null } | null;
  model?: BoardPickModel | null;
  preModel?: BoardPickModel | null;
};

export type OfficialResultRow = {
  /** Review item key `league:matchId`, or hkjcId / matchId for lookup. */
  key?: string;
  league?: string;
  matchId?: string;
  hkjcId?: string | null;
  home: number;
  away: number;
  finished: boolean;
  official?: boolean;
};

export type SettlePickFn = (
  item: ReviewItem,
  home: number,
  away: number,
) => { result: Exclude<ReviewResult, 'pending'>; units: number; hit: number };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asFinite(v: unknown, fallback: number | null): number | null {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function reviewItemKey(item: Pick<ReviewItem, 'key' | 'league' | 'matchId'>): string {
  const key = String(item.key || '').trim();
  if (key.includes(':')) return key;
  const league = String(item.league || '').trim();
  const matchId = String(item.matchId || '').trim();
  return league && matchId ? `${league}:${matchId}` : key;
}

export function boardMatchKey(match: BoardMatch): string {
  return `${String(match.league || '').trim()}:${String(match.id || '').trim()}`;
}

export function isSettled(item: ReviewItem): boolean {
  return item.result !== 'pending';
}

export function countSettled(items: ReviewItem[]): number {
  return items.filter(isSettled).length;
}

export function countPending(items: ReviewItem[]): number {
  return items.filter((i) => i.result === 'pending').length;
}

export function countHits(items: ReviewItem[]): { win: number; loss: number; other: number } {
  let win = 0;
  let loss = 0;
  let other = 0;
  for (const i of items) {
    if (i.result === 'pending') continue;
    if (i.result === 'win' || i.result === 'half') win += 1;
    else if (i.result === 'loss' || i.result === 'halfLoss') loss += 1;
    else other += 1;
  }
  return { win, loss, other };
}

export function computeSettledNByKey(items: ReviewItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    if (item.result === 'pending' || item.result === 'push' || !item.ftOfficial || item.hit == null) {
      continue;
    }
    const key = buildLearnKey(item.pick.market, item.league);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function mergeSettledNByKey(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    out[k] = Math.max(Number(out[k] || 0), Math.floor(n));
  }
  return out;
}

export function syncSettledNByKey(ledger: ReviewLedger): ReviewLedger {
  return {
    items: ledger.items,
    settledNByKey: mergeSettledNByKey(computeSettledNByKey(ledger.items), ledger.settledNByKey),
  };
}

/** Recency compare: later kickoff first, then later capturedAt. */
export function compareReviewRecency(a: ReviewItem, b: ReviewItem): number {
  return b.start.localeCompare(a.start) || b.capturedAt - a.capturedAt;
}

/** Recency sort: later kickoff first, then later capturedAt. */
export function sortReviewItems(items: ReviewItem[]): ReviewItem[] {
  return [...items].sort(compareReviewRecency);
}

/**
 * Settle first, then trim:
 * - settled: most recent SETTLED_CAP
 * - keep ALL started / in-progress / scored / unsettled pending
 * - cap only unstarted scoreless future games to the UNSTARTED_PENDING_CAP soonest kickoffs
 */
export function trimReviewLedger(items: ReviewItem[], now = Date.now()): ReviewItem[] {
  const settled = sortReviewItems(items.filter(isSettled)).slice(0, SETTLED_CAP);
  const startedOrScored: ReviewItem[] = [];
  const unstarted: ReviewItem[] = [];
  for (const item of items) {
    if (item.result !== 'pending') continue;
    const start = Date.parse(item.start);
    const scored = item.homeScore != null || item.awayScore != null;
    if (Number.isFinite(start) && start > now && !scored) unstarted.push(item);
    else startedOrScored.push(item);
  }
  unstarted.sort(
    (a, b) => a.start.localeCompare(b.start) || a.capturedAt - b.capturedAt,
  );
  return sortReviewItems([...settled, ...startedOrScored, ...unstarted.slice(0, UNSTARTED_PENDING_CAP)]);
}

/**
 * Choose the better row for the same stable key.
 * Settled always beats pending. A stale pending must never overwrite a settlement.
 */
export function preferReviewItem(current: ReviewItem, incoming: ReviewItem): ReviewItem {
  const curSettled = isSettled(current);
  const incSettled = isSettled(incoming);
  if (incSettled && !curSettled) return incoming;
  if (curSettled && !incSettled) return current;
  if (curSettled && incSettled) {
    const cAt = current.settledAt ?? 0;
    const iAt = incoming.settledAt ?? 0;
    if (iAt !== cAt) return iAt > cAt ? incoming : current;
    if (incoming.ftOfficial && !current.ftOfficial) return incoming;
    if (current.ftOfficial && !incoming.ftOfficial) return current;
    return incoming.capturedAt > current.capturedAt ? incoming : current;
  }
  // both pending
  if (incoming.ftOfficial && !current.ftOfficial) return incoming;
  if (current.ftOfficial && !incoming.ftOfficial) return current;
  const incScored = incoming.homeScore != null || incoming.awayScore != null;
  const curScored = current.homeScore != null || current.awayScore != null;
  if (incScored && !curScored) return incoming;
  if (curScored && !incScored) return current;
  return incoming.capturedAt >= current.capturedAt ? incoming : current;
}

export function mergeReviewLedgers(current: ReviewLedger, incoming: ReviewLedger): ReviewLedger {
  const map = new Map<string, ReviewItem>();
  for (const item of current.items) map.set(reviewItemKey(item), item);
  for (const item of incoming.items) {
    const id = reviewItemKey(item);
    const existing = map.get(id);
    map.set(id, existing ? preferReviewItem(existing, item) : item);
  }
  const items = sortReviewItems([...map.values()]);
  return syncSettledNByKey({
    items,
    settledNByKey: mergeSettledNByKey(current.settledNByKey, incoming.settledNByKey),
  });
}

export function parseReviewBackup(
  raw: unknown,
): { ok: true; file: ReviewBackupFile } | { ok: false; reason: string } {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
  }
  if (!isPlainObject(value)) return { ok: false, reason: 'not_object' };
  if (value.format !== REVIEW_BACKUP_FORMAT) return { ok: false, reason: 'bad_format' };
  if (Number(value.version) !== REVIEW_BACKUP_VERSION) return { ok: false, reason: 'bad_version' };
  if (!Array.isArray(value.items)) return { ok: false, reason: 'missing_items' };
  const items: ReviewItem[] = [];
  for (const row of value.items) {
    const parsed = parseReviewItem(row);
    if (!parsed) return { ok: false, reason: 'bad_item' };
    items.push(parsed);
  }
  const settledNByKey = parseSettledNByKey(value.settledNByKey);
  if (!settledNByKey) return { ok: false, reason: 'bad_settledNByKey' };
  return {
    ok: true,
    file: {
      format: REVIEW_BACKUP_FORMAT,
      version: REVIEW_BACKUP_VERSION,
      exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '',
      items,
      settledNByKey,
    },
  };
}

function parseSettledNByKey(raw: unknown): Record<string, number> | null {
  if (raw == null) return {};
  if (!isPlainObject(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!k || k.length > 80 || !Number.isFinite(n) || n < 0) continue;
    out[k] = Math.floor(n);
  }
  return out;
}

export function parseReviewItem(raw: unknown): ReviewItem | null {
  if (!isPlainObject(raw)) return null;
  const pickRaw = raw.pick;
  if (!isPlainObject(pickRaw)) return null;
  const market = String(pickRaw.market || '');
  if (!PICK_MARKETS.includes(market as PickMarket)) return null;
  const selection = String(pickRaw.selection || '');
  if (!selection) return null;
  const league = typeof raw.league === 'string' ? raw.league : '';
  const matchId = typeof raw.matchId === 'string' ? raw.matchId : '';
  const key =
    typeof raw.key === 'string' && raw.key.includes(':') ? raw.key : `${league}:${matchId}`;
  if (!key.includes(':') || !league || !matchId) return null;
  if (typeof raw.home !== 'string' || typeof raw.away !== 'string') return null;
  if (typeof raw.start !== 'string' || !raw.start) return null;
  const result = raw.result;
  if (typeof result !== 'string' || !RESULT_VALUES.includes(result as ReviewResult)) return null;
  const probability = asFinite(pickRaw.probability, null);
  if (probability == null) return null;
  const quality: DataQuality =
    raw.quality === 'thin' || raw.quality === 'solid' || raw.quality === 'fair'
      ? raw.quality
      : 'fair';
  return {
    key,
    league,
    leagueNameZh: typeof raw.leagueNameZh === 'string' ? raw.leagueNameZh : league,
    matchId,
    home: raw.home,
    away: raw.away,
    homeLogo: typeof raw.homeLogo === 'string' ? raw.homeLogo : null,
    awayLogo: typeof raw.awayLogo === 'string' ? raw.awayLogo : null,
    start: raw.start,
    source: raw.source === 'rebuild' ? 'rebuild' : 'live',
    capturedAt: asFinite(raw.capturedAt, 0) ?? 0,
    hkjcId: typeof raw.hkjcId === 'string' ? raw.hkjcId : null,
    pick: {
      market,
      selection,
      selectionLabel:
        typeof pickRaw.selectionLabel === 'string' ? pickRaw.selectionLabel : selection,
      probability,
      fairOdds: asFinite(pickRaw.fairOdds, 0) ?? 0,
      marketDecimal: asFinite(pickRaw.marketDecimal, null),
      edge: asFinite(pickRaw.edge, null),
      confidence: asFinite(pickRaw.confidence, 0) ?? 0,
      stake: asFinite(pickRaw.stake, null),
      note: typeof pickRaw.note === 'string' ? pickRaw.note : '',
    },
    quality,
    ouLine: asFinite(raw.ouLine, 2.5) ?? 2.5,
    ahLine: asFinite(raw.ahLine, -0.5) ?? -0.5,
    pHome: asFinite(raw.pHome, 0) ?? 0,
    pDraw: asFinite(raw.pDraw, 0) ?? 0,
    pAway: asFinite(raw.pAway, 0) ?? 0,
    pOver: asFinite(raw.pOver, 0) ?? 0,
    pBtts: asFinite(raw.pBtts, 0) ?? 0,
    pAhHome: asFinite(raw.pAhHome, 0) ?? 0,
    homeScore: asFinite(raw.homeScore, null),
    awayScore: asFinite(raw.awayScore, null),
    ftOfficial: raw.ftOfficial === true,
    settledAt: asFinite(raw.settledAt, null),
    result: result as ReviewResult,
    units: asFinite(raw.units, null),
    hit: asFinite(raw.hit, null),
    favouriteSelection: typeof raw.favouriteSelection === 'string' ? raw.favouriteSelection : null,
  };
}

export function buildReviewBackup(ledger: ReviewLedger, now = new Date()): ReviewBackupFile {
  const synced = syncSettledNByKey(ledger);
  return {
    format: REVIEW_BACKUP_FORMAT,
    version: REVIEW_BACKUP_VERSION,
    exportedAt: now.toISOString(),
    items: synced.items,
    settledNByKey: synced.settledNByKey,
  };
}

export function importReviewLedger(input: {
  current: ReviewLedger;
  backup: ReviewBackupFile | unknown;
  mode?: MergeMode;
}): { ok: boolean; reason?: string; mode: MergeMode; ledger: ReviewLedger } {
  const mode: MergeMode = input.mode === 'replace' ? 'replace' : 'merge';
  const parsed = parseReviewBackup(input.backup);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, mode, ledger: input.current };
  }
  const incoming: ReviewLedger = {
    items: parsed.file.items,
    settledNByKey: parsed.file.settledNByKey,
  };
  if (mode === 'replace') {
    return { ok: true, mode, ledger: syncSettledNByKey(incoming) };
  }
  return { ok: true, mode, ledger: mergeReviewLedgers(input.current, incoming) };
}

/**
 * First-deploy rule: if the shared store has no items, use the seed.
 * If the store already has items, do not re-apply the seed (that would
 * reintroduce stale pending for matches already booked).
 */
export function seedIfEmpty(current: ReviewLedger | null | undefined, seed: unknown): ReviewLedger {
  const hasItems = !!current && Array.isArray(current.items) && current.items.length > 0;
  if (hasItems) return syncSettledNByKey(current!);
  const parsed = parseReviewBackup(seed);
  if (!parsed.ok) {
    return { items: [], settledNByKey: {} };
  }
  return syncSettledNByKey({
    items: parsed.file.items,
    settledNByKey: parsed.file.settledNByKey,
  });
}

/** Default 1x2 / ah / ou / btts settle used by smokes; live app should keep its `eg`. */
export function settleReviewPick(
  item: ReviewItem,
  home: number,
  away: number,
): { result: Exclude<ReviewResult, 'pending'>; units: number; hit: number } {
  const market = item.pick.market;
  const sel = item.pick.selection;
  let hit = 0;
  if (market === '1x2' || market === 'HAD') {
    const outcome = home > away ? 'home' : home < away ? 'away' : 'draw';
    hit = sel === outcome ? 1 : 0;
  } else if (market === 'ou' || market === 'HIL') {
    const total = home + away;
    const line = item.ouLine;
    if (total > line) hit = sel === 'over' ? 1 : 0;
    else if (total < line) hit = sel === 'under' ? 1 : 0;
    else return { result: 'push', units: 0, hit: 0 };
  } else if (market === 'btts' || market === 'BTTS') {
    const both = home > 0 && away > 0;
    const yes = sel === 'yes' || sel === 'y';
    hit = both === yes ? 1 : 0;
  } else if (market === 'ah' || market === 'HDC') {
    const adj = home + item.ahLine - away;
    if (adj === 0) return { result: 'push', units: 0, hit: 0 };
    const homeWin = adj > 0;
    hit = (sel === 'home' && homeWin) || (sel === 'away' && !homeWin) ? 1 : 0;
  } else {
    hit = 0;
  }
  if (hit === 1) return { result: 'win', units: 1, hit: 1 };
  return { result: 'loss', units: 0, hit: 0 };
}

export function bookItem(
  item: ReviewItem,
  home: number,
  away: number,
  official: boolean,
  now = Date.now(),
  settle: SettlePickFn = settleReviewPick,
): ReviewItem {
  const settled = settle(item, home, away);
  return {
    ...item,
    homeScore: home,
    awayScore: away,
    ftOfficial: official,
    settledAt: now,
    result: settled.result,
    units: settled.units,
    hit: settled.hit,
    hkjcId: item.hkjcId,
  };
}

function modelFromMatch(match: BoardMatch): BoardPickModel | null {
  return match.preModel ?? match.model ?? null;
}

function newPendingFromMatch(
  match: BoardMatch,
  model: BoardPickModel,
  source: ReviewSource,
  now: number,
): ReviewItem {
  const quality: DataQuality =
    model.dataQuality === 'thin' || model.dataQuality === 'solid' || model.dataQuality === 'fair'
      ? model.dataQuality
      : 'fair';
  const stateScores = match.state === 'pre' ? null : true;
  return {
    key: boardMatchKey(match),
    league: match.league,
    leagueNameZh: match.leagueNameZh || match.league,
    matchId: match.id,
    home: match.home.nameZh || match.home.name || '',
    away: match.away.nameZh || match.away.name || '',
    homeLogo: match.home.logo ?? null,
    awayLogo: match.away.logo ?? null,
    start: match.start,
    source,
    capturedAt: now,
    hkjcId: match.hkjc?.id ?? null,
    pick: { ...model.pick },
    quality,
    ouLine: model.ouLine ?? 2.5,
    ahLine: model.ahLine ?? -0.5,
    pHome: model.pHome ?? 0,
    pDraw: model.pDraw ?? 0,
    pAway: model.pAway ?? 0,
    pOver: model.pOver ?? 0,
    pBtts: model.pBtts ?? 0,
    pAhHome: model.pAhHome ?? 0,
    homeScore: stateScores ? (match.home.score ?? null) : null,
    awayScore: stateScores ? (match.away.score ?? null) : null,
    ftOfficial: false,
    settledAt: null,
    result: 'pending',
    units: null,
    hit: null,
    favouriteSelection: null,
  };
}

/**
 * Can we book this board match as official FT?
 * - officialFt present with valid scores → yes, even if state mapping lagged on 'in'
 * - else state==='post' with valid scores (mapping missed officialFt)
 * - NEVER book state pre/in/live/HT using running scores without officialFt
 */
export function canBookBoardMatch(match: BoardMatch): {
  ok: boolean;
  home?: number;
  away?: number;
} {
  const official = match.officialFt;
  if (official && isValidScore(official.home, official.away)) {
    const gate = settleFtOnly({ phase: 'ft', homeScore: official.home, awayScore: official.away });
    return gate.mayApplyLearn
      ? { ok: true, home: Number(official.home), away: Number(official.away) }
      : { ok: false };
  }
  if (match.state !== 'post') return { ok: false };
  const home = official?.home ?? match.home.score;
  const away = official?.away ?? match.away.score;
  if (!isValidScore(home, away)) return { ok: false };
  const gate = settleFtOnly({ phase: 'ft', homeScore: home, awayScore: away });
  return gate.mayApplyLearn ? { ok: true, home: Number(home), away: Number(away) } : { ok: false };
}

/**
 * Ingest today/tomorrow/yesterday board matches into the ledger.
 * Fixes vs live `cg` (index-DQCNxAyf.js):
 * - state==='in' with no existing row CREATES a pending row (in-play re-entry)
 * - officialFt books even if state is not yet 'post'
 * - live/HT scores without officialFt never book
 * - settle first, then trim
 */
export function ingestBoardMatches(
  items: ReviewItem[],
  matches: BoardMatch[],
  now = Date.now(),
  settle: SettlePickFn = settleReviewPick,
): ReviewItem[] {
  const map = new Map<string, ReviewItem>();
  for (const item of items) {
    map.set(reviewItemKey(item), {
      ...item,
      pick: { ...item.pick },
      units: item.result === 'pending' ? null : item.units ?? 0,
      ftOfficial: item.ftOfficial ?? item.result !== 'pending',
    });
  }

  for (const match of matches) {
    const key = boardMatchKey(match);
    if (!key.includes(':')) continue;
    const existing = map.get(key);
    const hkjcId = existing?.hkjcId ?? match.hkjc?.id ?? null;
    const book = canBookBoardMatch(match);
    const home = match.officialFt?.home ?? match.home.score;
    const away = match.officialFt?.away ?? match.away.score;

    if (match.state === 'pre') {
      if (!match.model || (existing && existing.result !== 'pending')) continue;
      if (existing) {
        map.set(key, {
          ...existing,
          homeLogo: match.home.logo ?? existing.homeLogo,
          awayLogo: match.away.logo ?? existing.awayLogo,
          hkjcId,
        });
      } else {
        map.set(key, newPendingFromMatch(match, match.model, 'live', now));
      }
      continue;
    }

    if (existing && existing.result === 'pending') {
      if (book.ok) {
        map.set(key, bookItem({ ...existing, hkjcId }, book.home!, book.away!, true, now, settle));
      } else if (home != null && away != null) {
        // Live / HT score update only — not official.
        map.set(key, {
          ...existing,
          homeScore: Number.isFinite(Number(home)) ? Number(home) : existing.homeScore,
          awayScore: Number.isFinite(Number(away)) ? Number(away) : existing.awayScore,
          hkjcId,
          ftOfficial: false,
        });
      } else if (hkjcId && !existing.hkjcId) {
        map.set(key, { ...existing, hkjcId });
      }
      continue;
    }

    if (existing) continue; // already settled — never overwrite with board pending/live

    // No existing row. Live hole was: `if (!r && e.state !== 'in')` skipped in-play.
    if (match.state === 'in') {
      const model = modelFromMatch(match);
      if (!model) continue;
      const row = newPendingFromMatch(match, model, 'live', now);
      if (book.ok) map.set(key, bookItem(row, book.home!, book.away!, true, now, settle));
      else map.set(key, row);
      continue;
    }

    if (book.ok) {
      const model = modelFromMatch(match);
      if (!model) continue;
      const row = newPendingFromMatch(match, model, 'rebuild', now);
      map.set(key, bookItem(row, book.home!, book.away!, true, now, settle));
    } else if (match.state === 'post' && modelFromMatch(match)) {
      const row = newPendingFromMatch(match, modelFromMatch(match)!, 'rebuild', now);
      map.set(key, {
        ...row,
        homeScore: isValidScore(home, away) ? Number(home) : null,
        awayScore: isValidScore(home, away) ? Number(away) : null,
        hkjcId,
        ftOfficial: false,
      });
    }
  }

  return trimReviewLedger([...map.values()], now);
}

/**
 * Apply official FT rows (from matchResults / review-results) onto existing pending items.
 * finished && official!==false only. HT/live (official:false or finished:false) update scores only.
 */
export function applyOfficialResults(
  items: ReviewItem[],
  results: OfficialResultRow[],
  now = Date.now(),
  settle: SettlePickFn = settleReviewPick,
): ReviewItem[] {
  if (!results.length) return items;
  const byKey = new Map<string, ReviewItem>();
  const byHkjc = new Map<string, string>();
  const byMatchId = new Map<string, string[]>();
  for (const item of items) {
    const id = reviewItemKey(item);
    byKey.set(id, item);
    if (item.hkjcId) byHkjc.set(String(item.hkjcId), id);
    const list = byMatchId.get(item.matchId) || [];
    list.push(id);
    byMatchId.set(item.matchId, list);
  }

  let changed = false;
  for (const row of results) {
    const direct =
      (row.key && byKey.get(row.key)) ||
      (row.league && row.matchId && byKey.get(`${row.league}:${row.matchId}`)) ||
      (row.hkjcId && byKey.get(byHkjc.get(String(row.hkjcId)) || '')) ||
      (row.matchId && (byMatchId.get(row.matchId) || []).map((k) => byKey.get(k)!).find(Boolean));
    const item = direct || null;
    if (!item || item.result !== 'pending') continue;
    const official = row.official !== false;
    if (row.finished && official && isValidScore(row.home, row.away)) {
      const score: OfficialFtScore = {
        home: Number(row.home),
        away: Number(row.away),
        stageId: 5,
        official: true,
        finished: true,
      };
      if (!mayBookOfficialFt(score)) continue;
      byKey.set(reviewItemKey(item), bookItem(item, score.home, score.away, true, now, settle));
      changed = true;
    } else if (item.homeScore !== row.home || item.awayScore !== row.away) {
      byKey.set(reviewItemKey(item), {
        ...item,
        homeScore: row.home,
        awayScore: row.away,
        ftOfficial: false,
      });
      changed = true;
    }
  }
  return changed ? trimReviewLedger([...byKey.values()], now) : items;
}

export function ledgerCounts(items: ReviewItem[]): {
  total: number;
  settled: number;
  pending: number;
  win: number;
  loss: number;
} {
  const hits = countHits(items);
  return {
    total: items.length,
    settled: countSettled(items),
    pending: countPending(items),
    win: hits.win,
    loss: hits.loss,
  };
}
