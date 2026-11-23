/**
 * Client wiring for the shared 覆核帳本.
 *
 * localStorage key `pitchedge-review` becomes a cache only. On load (and on
 * a 45–60s poll) replace it with the server snapshot from getSharedLedger.
 * Visitors must not be able to overwrite the shared store from the browser.
 *
 * Export: download the shared snapshot (same file format as today).
 * Import: device-only preview, or disable the button. Never call a server
 * write / replace with a user-picked JSON.
 */

export const SHARED_LEDGER_COPY = {
  source: '資料來源：共用覆核帳本（同一條 live 連結，所有人見到同一份）。',
  exportHint: '匯出係共用帳本嘅備份，方便你自己存檔。',
  importDisabled: '匯入只可喺呢部機預覽，唔會改到其他人見到嘅共用帳本。',
  importRemoved: '共用帳本由伺服器管理，已停用「覆蓋共用帳本」匯入。',
} as const;

export const SHARED_LEDGER_POLL_MS = 45_000;

export type SharedLedgerSnapshot = {
  format: 'pitchedge-review-backup';
  version: 1;
  exportedAt: string;
  items: unknown[];
  settledNByKey: Record<string, number>;
  counts?: { settled?: number; pending?: number; win?: number; loss?: number };
  missingToken?: boolean;
  booked?: number;
  asOfHkt?: string;
};

/**
 * Wire guide (port into the live zustand review store + u_() hook):
 *
 * 1. Add server fn `getSharedLedger` (GET or POST) that runs runReviewBooker
 *    and returns sharedLedgerPayload(...). Never accept a full ledger from
 *    the client. Do not expose replace/import-to-shared.
 *
 * 2. In the app shell (existing u_() next to board ingest):
 *      const snap = await getSharedLedger()
 *      replaceLedger(snap.items, snap.settledNByKey)
 *    Poll every SHARED_LEDGER_POLL_MS. Hydrate after zustand persist so the
 *    shared snapshot replaces any stale device cache.
 *
 * 3. Keep persist middleware as a cache for instant first paint, but treat
 *    the server snapshot as source of truth whenever it arrives.
 *
 * 4. Review page: replace the「資料只存在呢部機…雲端同步稍後先做」line with
 *    SHARED_LEDGER_COPY.source. Keep「匯出複盤」. For「匯入複盤」:
 *    - disable the「覆蓋現有帳本」checkbox (it must not write the shared store)
 *    - or hide import; if kept, apply only to a local preview overlay that
 *      is discarded on the next shared fetch, and show importDisabled copy.
 *
 * 5. Client review-results / applyScores may stay as a best-effort UI hint
 *    but must not be the booking path. Official FT booking is server-side.
 */
export const REVIEW_SHARED_WIRE = true;
