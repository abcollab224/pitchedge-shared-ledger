/**
 * Server-side official-FT booker for the shared 覆核帳本.
 *
 * Runs on the Vercel/Grok server (board loader, review loader, or
 * getSharedLedger). It must NOT depend on a visitor's browser, the box
 * proxy, or client POSTs of a full ledger.
 *
 * Pipeline:
 *   1. Load shared ledger (seed-if-empty from the 11/22 bot export)
 *   2. Ingest today / tomorrow / yesterday boards (in-play re-entry + officialFt rules)
 *   3. For pending started > 15 minutes, fetch HKJC matchResults (paged ≤20)
 *      and apply official FT (stage 5 / 100 only; HT/ET do not book)
 *   4. Trim (settle first; keep started/scored pending; cap unstarted future at 200;
 *      settled cap 800)
 *   5. CAS-write via GitHub SHA, merge on conflict (settled wins)
 *
 * Wire this inside existing TanStack Start server functions. Reuse the
 * project's board builder for step 2 (it already runs on the server for SSR).
 */

import {
  applyOfficialResults,
  ingestBoardMatches,
  ledgerCounts,
  seedIfEmpty,
  syncSettledNByKey,
  trimReviewLedger,
  type BoardMatch,
  type OfficialResultRow,
  type ReviewItem,
  type ReviewLedger,
  type SettlePickFn,
} from '../math/reviewLedger.ts';
import {
  fetchHkjcMatchResults,
  hktDateString,
  resultsDateRangeForPending,
  type HkjcFinishedMatch,
} from './hkjcMatchResults.ts';
import {
  loadSharedLedger,
  readGithubStoreConfig,
  saveSharedLedgerWithMerge,
  type FetchLike,
  type GithubStoreConfig,
  type StoreRead,
} from './sharedLedgerStore.ts';

export const PENDING_RESULTS_GRACE_MS = 15 * 60 * 1000; // 15 minutes after kickoff
export const BOOKER_COOLDOWN_MS = 45 * 1000;

export type BookerInput = {
  seed: unknown;
  boards?: BoardMatch[];
  now?: number;
  settle?: SettlePickFn;
  fetchImpl?: FetchLike;
  config?: GithubStoreConfig | { missing: string[] };
  /** Inject results in tests; skip network. */
  results?: OfficialResultRow[] | HkjcFinishedMatch[];
  persist?: boolean;
  cooldownMs?: number;
  lastBookAt?: number;
};

export type BookerResult = {
  ledger: ReviewLedger;
  sha: string | null;
  seeded: boolean;
  persisted: boolean;
  missingToken: boolean;
  skippedCooldown: boolean;
  counts: ReturnType<typeof ledgerCounts>;
  booked: number;
  reason?: string;
};

function asOfficialRows(rows: OfficialResultRow[] | HkjcFinishedMatch[]): OfficialResultRow[] {
  return rows.map((row) => {
    if ('officialFt' in row) {
      const ft = row.officialFt;
      return {
        hkjcId: row.id,
        matchId: row.id,
        home: ft?.home ?? -1,
        away: ft?.away ?? -1,
        finished: !!ft && !row.voided,
        official: !!ft && !row.voided,
      };
    }
    return row;
  }).filter((r) => r.finished && r.official !== false && r.home >= 0 && r.away >= 0);
}

function pendingNeedingResults(items: ReviewItem[], now: number): ReviewItem[] {
  return items.filter(
    (i) => i.result === 'pending' && Number.isFinite(Date.parse(i.start)) && Date.parse(i.start) < now - PENDING_RESULTS_GRACE_MS,
  );
}

let lastBookAtMemory = 0;

export async function runReviewBooker(input: BookerInput): Promise<BookerResult> {
  const now = input.now ?? Date.now();
  const cooldown = input.cooldownMs ?? BOOKER_COOLDOWN_MS;
  const last = input.lastBookAt ?? lastBookAtMemory;
  if (now - last < cooldown && input.results == null) {
    const loaded = await loadSharedLedger({
      seed: input.seed,
      config: input.config,
      fetchImpl: input.fetchImpl,
    });
    return {
      ledger: loaded.ledger,
      sha: loaded.sha,
      seeded: loaded.seeded,
      persisted: false,
      missingToken: loaded.missingToken,
      skippedCooldown: true,
      counts: ledgerCounts(loaded.ledger.items),
      booked: 0,
      reason: 'cooldown',
    };
  }

  const loaded: StoreRead = await loadSharedLedger({
    seed: input.seed,
    config: input.config,
    fetchImpl: input.fetchImpl,
  });

  let items = seedIfEmpty(loaded.ledger, input.seed).items;
  const settledBefore = items.filter((i) => i.result !== 'pending').length;

  if (input.boards?.length) {
    items = ingestBoardMatches(items, input.boards, now, input.settle);
  }

  const stalePending = pendingNeedingResults(items, now);
  let resultRows: OfficialResultRow[] = [];
  if (input.results) {
    resultRows = asOfficialRows(input.results);
  } else if (stalePending.length) {
    const range = resultsDateRangeForPending(
      stalePending.map((i) => i.start),
      new Date(now),
    );
    if (range) {
      const finished = await fetchHkjcMatchResults({
        startDate: range.startDate,
        endDate: range.endDate,
        fetchImpl: input.fetchImpl,
      });
      resultRows = asOfficialRows(finished);
    }
  }

  if (resultRows.length) {
    items = applyOfficialResults(items, resultRows, now, input.settle);
  }

  items = trimReviewLedger(items, now);
  const ledger = syncSettledNByKey({ items, settledNByKey: loaded.ledger.settledNByKey });
  const settledAfter = ledger.items.filter((i) => i.result !== 'pending').length;
  const booked = Math.max(0, settledAfter - settledBefore);

  const persist = input.persist !== false;
  const config = input.config ?? readGithubStoreConfig();
  let sha = loaded.sha;
  let persisted = false;
  let reason: string | undefined;
  if (persist && !('missing' in config) && (loaded.seeded || booked > 0 || itemsChanged(loaded.ledger.items, ledger.items))) {
    const saved = await saveSharedLedgerWithMerge({
      next: ledger,
      sha: loaded.sha,
      seed: input.seed,
      config,
      fetchImpl: input.fetchImpl,
      message: `pitchedge booker settled ${settledAfter} pending ${ledgerCounts(ledger.items).pending}`,
    });
    persisted = saved.ok;
    sha = saved.sha;
    reason = saved.ok ? undefined : saved.reason;
  } else if (persist && 'missing' in config) {
    reason = 'missing_token';
  }

  lastBookAtMemory = now;
  return {
    ledger,
    sha,
    seeded: loaded.seeded,
    persisted,
    missingToken: loaded.missingToken || ('missing' in config),
    skippedCooldown: false,
    counts: ledgerCounts(ledger.items),
    booked,
    reason,
  };
}

function itemsChanged(a: ReviewItem[], b: ReviewItem[]): boolean {
  if (a.length !== b.length) return true;
  const map = new Map(a.map((i) => [i.key, i]));
  for (const item of b) {
    const prev = map.get(item.key);
    if (!prev) return true;
    if (prev.result !== item.result || prev.ftOfficial !== item.ftOfficial || prev.settledAt !== item.settledAt) {
      return true;
    }
  }
  return false;
}

/** Payload returned to every client — same object for every visitor. */
export function sharedLedgerPayload(result: BookerResult, now = new Date()) {
  return {
    format: 'pitchedge-review-backup' as const,
    version: 1 as const,
    exportedAt: now.toISOString(),
    items: result.ledger.items,
    settledNByKey: result.ledger.settledNByKey,
    counts: result.counts,
    missingToken: result.missingToken,
    booked: result.booked,
    asOfHkt: new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Hong_Kong',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now),
  };
}

export { hktDateString };
