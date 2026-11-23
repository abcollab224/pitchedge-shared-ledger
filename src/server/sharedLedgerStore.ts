/**
 * Server-only durable store for the shared 覆核帳本.
 *
 * Recommended backend: a private GitHub repo file via the Contents API,
 * with the token ONLY in server env (never imported by client modules).
 *
 * Env (parent sets these in the Grok project / Publish secrets — not the user):
 *   PITCHEDGE_LEDGER_GITHUB_TOKEN   fine-grained PAT, Contents: Read+Write on this repo only
 *   PITCHEDGE_LEDGER_GITHUB_REPO    owner/name  e.g. YCC8234896728/pitchedge-shared-ledger
 *   PITCHEDGE_LEDGER_GITHUB_PATH    default pitchedge-review-shared.json
 *   PITCHEDGE_LEDGER_GITHUB_BRANCH  default main
 *
 * Concurrency: optimistic SHA. On 409, re-read, mergeReviewLedgers (settled
 * wins over pending), retry. A stale client cannot wipe newer settlements.
 */

import {
  buildReviewBackup,
  mergeReviewLedgers,
  parseReviewBackup,
  seedIfEmpty,
  type ReviewBackupFile,
  type ReviewLedger,
} from '../math/reviewLedger.ts';

export const DEFAULT_LEDGER_PATH = 'pitchedge-review-shared.json';
export const DEFAULT_LEDGER_BRANCH = 'main';

export type StoreRead = {
  ledger: ReviewLedger;
  sha: string | null;
  seeded: boolean;
  source: 'github' | 'seed' | 'empty' | 'memory';
  missingToken: boolean;
};

export type StoreWrite = {
  ok: boolean;
  sha: string | null;
  ledger: ReviewLedger;
  reason?: string;
  conflict?: boolean;
};

export type GithubStoreConfig = {
  token: string;
  repo: string; // owner/name
  path: string;
  branch: string;
};

export function readGithubStoreConfig(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): GithubStoreConfig | { missing: string[] } {
  const token = (env.PITCHEDGE_LEDGER_GITHUB_TOKEN || '').trim();
  const repo = (env.PITCHEDGE_LEDGER_GITHUB_REPO || '').trim();
  const path = (env.PITCHEDGE_LEDGER_GITHUB_PATH || DEFAULT_LEDGER_PATH).trim();
  const branch = (env.PITCHEDGE_LEDGER_GITHUB_BRANCH || DEFAULT_LEDGER_BRANCH).trim();
  const missing: string[] = [];
  if (!token) missing.push('PITCHEDGE_LEDGER_GITHUB_TOKEN');
  if (!repo || !repo.includes('/')) missing.push('PITCHEDGE_LEDGER_GITHUB_REPO');
  if (missing.length) return { missing };
  return { token, repo, path, branch };
}

function apiBase(repo: string, path: string): string {
  return `https://api.github.com/repos/${repo}/contents/${path.replace(/^\/+/, '')}`;
}

function decodeBase64Json(content: string): unknown {
  const cleaned = content.replace(/\n/g, '');
  const json = Buffer.from(cleaned, 'base64').toString('utf8');
  return JSON.parse(json);
}

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export type FetchLike = typeof fetch;

export async function loadSharedLedger(input: {
  seed: unknown;
  config?: GithubStoreConfig | { missing: string[] };
  fetchImpl?: FetchLike;
}): Promise<StoreRead> {
  const seededEmpty = seedIfEmpty({ items: [], settledNByKey: {} }, input.seed);
  const config = input.config ?? readGithubStoreConfig();
  if ('missing' in config) {
    return {
      ledger: seededEmpty,
      sha: null,
      seeded: seededEmpty.items.length > 0,
      source: seededEmpty.items.length ? 'seed' : 'empty',
      missingToken: true,
    };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${apiBase(config.repo, config.path)}?ref=${encodeURIComponent(config.branch)}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token}`,
      'User-Agent': 'PitchEdge-shared-ledger',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) {
    return {
      ledger: seededEmpty,
      sha: null,
      seeded: seededEmpty.items.length > 0,
      source: seededEmpty.items.length ? 'seed' : 'empty',
      missingToken: false,
    };
  }
  if (!res.ok) {
    throw new Error(`ledger_github_read_${res.status}`);
  }
  const body = (await res.json()) as { sha?: string; content?: string };
  if (!body.content) {
    return {
      ledger: seededEmpty,
      sha: body.sha ?? null,
      seeded: seededEmpty.items.length > 0,
      source: seededEmpty.items.length ? 'seed' : 'empty',
      missingToken: false,
    };
  }
  const parsed = parseReviewBackup(decodeBase64Json(body.content));
  if (!parsed.ok) {
    // Do not wipe a corrupt remote file with the seed automatically.
    throw new Error(`ledger_github_parse_${parsed.reason}`);
  }
  const remote: ReviewLedger = {
    items: parsed.file.items,
    settledNByKey: parsed.file.settledNByKey,
  };
  // First deploy: empty remote file is treated as empty and seeded.
  const ledger = seedIfEmpty(remote, input.seed);
  const seeded = remote.items.length === 0 && ledger.items.length > 0;
  return {
    ledger,
    sha: body.sha ?? null,
    seeded,
    source: seeded ? 'seed' : 'github',
    missingToken: false,
  };
}

export async function saveSharedLedger(input: {
  ledger: ReviewLedger;
  sha: string | null;
  config: GithubStoreConfig;
  message?: string;
  fetchImpl?: FetchLike;
}): Promise<StoreWrite> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const file: ReviewBackupFile = buildReviewBackup(input.ledger);
  const body: Record<string, unknown> = {
    message: input.message || `pitchedge shared ledger ${file.exportedAt}`,
    content: encodeBase64Json(file),
    branch: input.config.branch,
  };
  if (input.sha) body.sha = input.sha;
  const res = await fetchImpl(apiBase(input.config.repo, input.config.path), {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${input.config.token}`,
      'User-Agent': 'PitchEdge-shared-ledger',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 409 || res.status === 422) {
    return { ok: false, sha: input.sha, ledger: input.ledger, conflict: true, reason: `github_${res.status}` };
  }
  if (!res.ok) {
    return { ok: false, sha: input.sha, ledger: input.ledger, reason: `github_${res.status}` };
  }
  const json = (await res.json()) as { content?: { sha?: string } };
  return { ok: true, sha: json.content?.sha ?? null, ledger: input.ledger };
}

/**
 * Write with SHA retry. If another booker wins the race, merge (settled wins)
 * and retry instead of overwriting.
 */
export async function saveSharedLedgerWithMerge(input: {
  next: ReviewLedger;
  sha: string | null;
  seed: unknown;
  config: GithubStoreConfig;
  fetchImpl?: FetchLike;
  message?: string;
  attempts?: number;
}): Promise<StoreWrite> {
  const attempts = input.attempts ?? 4;
  let sha = input.sha;
  let next = input.next;
  for (let i = 0; i < attempts; i += 1) {
    const wrote = await saveSharedLedger({
      ledger: next,
      sha,
      config: input.config,
      message: input.message,
      fetchImpl: input.fetchImpl,
    });
    if (wrote.ok || !wrote.conflict) return wrote;
    const latest = await loadSharedLedger({
      seed: input.seed,
      config: input.config,
      fetchImpl: input.fetchImpl,
    });
    next = mergeReviewLedgers(latest.ledger, next);
    sha = latest.sha;
  }
  return { ok: false, sha, ledger: next, conflict: true, reason: 'retry_exhausted' };
}
