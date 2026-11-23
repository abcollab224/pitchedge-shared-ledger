# PitchEdge — 共用覆核帳本 + 法定全場入帳修復，請即套用並 **Re-Publish**

對話：https://grok.com/c/84b2c4c2-5c96-46c9-b024-31a273cf069c  
Live（**必須保持**）：https://dawn-apex-lagoon-gold.grok.me/

今次 **必須 Re-Publish / Publish** 到同一個 live URL。  
唔好改 tip gate／校準 v2。唔好發明賽事或假樣本。預測／覆核路徑禁止 `Math.random`。

用戶要求（2026-11-23）：「你一次過搞埋啦，唔好要我搞。我想全部人入個條 link 都係一樣嘅內容。」  
所以：**唔好再叫用戶喺手機匯入 JSON。** 發布後，任何人打開同一條 live 連結，都要見到同一份覆核帳本（已結算、命中率、近況、待完場、baselines、名單）。

完整設計同參考實作喺 `/workspace/pitchedge-hitrate-patch/`（尤其 `SHARED_LEDGER_DESIGN.md` 同下面列出嘅 `src/`）。可以直接 port 呢啲檔。

---

## 共用帳本已經備好（唔好叫用戶做，唔好再要 PAT）

耐久儲存已經開好，而且 **已經用馬會 `matchResults` 把種子入帳**。唔好再叫用戶匯入，亦 **唔好要求設定 GitHub token / env**（Grok 專案未必有 server secrets；token 亦唔可以寫進原始碼）。

- Repo：https://github.com/abcollab224/pitchedge-shared-ledger
- 共用 JSON（公開 raw，CORS `*`）：  
  https://raw.githubusercontent.com/abcollab224/pitchedge-shared-ledger/main/pitchedge-review-shared.json
- 參考實作（請直接 port）：同一個 repo 嘅 `src/` 同這份說明
- 2026-11-23 08:33 香港時間已跑官方全場入帳後的 snapshot：  
  **已結算 638**（贏 299 + 輸 339，命中率 47%），**待完場 6**（全部係 23/11 朝早未完／剛開賽場）。  
  原本種子係 bot 11/22 11:49 匯出嘅 446 已結算 + 198 待完場；今次入帳咗 192 場。  
  **唔好用舊嘅 446/198 種子覆蓋呢份已入帳檔。** 14–19/11 仍然缺失，唔好發明。

Server 讀帳本：

1. `GET` 上面條 raw URL（加 cache-bust query，例如 `?t=` + Date.now()，因為 raw.githubusercontent.com 可能 cache 5 分鐘）
2. 解析 `pitchedge-review-backup` v1（`items` + `settledNByKey`）
3. 喺 server 跑 booker：ingest 今日／聽日／昨日 board，再用 **完全一樣** 嘅白名單 `matchResults` query 取法定全場（見下；缺 `poolInfo` 或改空白會 WHITELIST_ERROR）
4. 把結果回傳俾所有 client（`replaceLedger`）。localStorage 只係 cache。
5. **而家唔使** 由 Vercel 寫返 GitHub（無 token）。持久化由同一條 raw 檔維持；之後新場會再更新呢個檔。Server booker 仍然要喺每次 `getSharedLedger` 把最新完場加進 **今次 response**，等訪客見到新鮮數字。

Query 必須用 repo 入面 `src/server/hkjcMatchResults.ts` 的 `MATCH_RESULTS_QUERY`（同 `football-pipeline/gql/matchResults.request.json` 字節一致，包括 `poolInfo` 同空白）。

---

## 診斷（為什麼已結算卡 446，同點解唔能再靠手機匯入）

20/11 嘅 pending cap 修復已經生效（live `ng=800`、`rg=200`，先入帳再 trim）。22/11 11:49 匯出待完場已去到 198，20–23/11 場次都喺帳本。**14–19/11 已經唔喺呢份種子，唔好憑空加返。**

但官方全場入帳仍然壞咗（bot 側）：

- 馬會收盤後，`matchList`／昨日板會空（live 昨日頁已寫「馬會已收盤。昨日場次可於覆核頁查看。」）。20–22/11 完場唔再出現喺今日／昨日／聽日 board，ingest 無 official FT 可入。
- 餘下路徑係 client hook `u_()` POST `review-results`（現有 `_serverFn` hash `8b1ebb6b1932a7bbcfb09193f8b78c5ecbf180c3ef715b8323152213648a2f37`）再 `applyScores`。Bot 瀏覽器曾經對 `info.cld.hkjc.com/graphql/base/` 同網站自己嘅 `_serverFn` 出現 `net::ERR_PROXY_CONNECTION_FAILED`。板面靠 SSR 仍然睇到，所以無頁面錯誤，但入帳從未跑過。用戶手機可以打到 `_serverFn`，所以手機能入帳、bot 帳本停在 446。
- Live ingest `cg` 仍然：`state==="in"` 而且帳本未有呢行就 **skip**（即場被 cap 擠走過嘅場唔會再入待結）；而且只喺 `state==="post"` 先入帳，如果已有 `officialFt` 但 state 仲係 `in` 就只更新非正式比分。

23/11 朝用正確 header 直接 POST GraphQL `matchResults`（唔係 matchList）可以取到法定全場。分頁視窗必須 **≤20**（大過 20 會回 0 行）。20–23/11 共 265 場完場；種子 198 場待結之中，當時已有 **191** 場有官方全場（20–22/11 全部 + 23/11 嘅 27 場）。所以只要 server 端 booker 用 `matchResults`，第一次 Publish 之後已結算就應該明顯超過 446。

---

## 必須改

### 1. 共用帳本做單一真相來源

唔好再以裝置 localStorage `pitchedge-review` 做權威。改為：

- 新增 server function `getSharedLedger`（只讀給 client）：喺 server 跑 booker（45 秒冷卻），回傳同一份 snapshot：`{ format, version, exportedAt, items, settledNByKey, counts }`。
- **唔好** 提供「用上傳 JSON 覆蓋共用帳本」嘅 server 寫入。Client **唔可以** POST 成份帳本。
- App shell（現有常駐 hook `u_()`）：hydration 之後拉 `getSharedLedger`，`replaceLedger(items, settledNByKey)`。之後每 45 秒 poll。localStorage 只係 cache，被共用 snapshot 覆蓋。
- 權威來源係上面嘅 raw JSON。如果 raw 讀取失敗，先用上一次成功 snapshot；**唔好** 回退去裝置 localStorage 當真相，亦 **唔好** 用舊 446/198 種子覆蓋已入帳嘅 638 場。
- 而家唔使 GitHub Contents API 寫入。Client **仍然唔可以** POST 成份帳本。

參考：`src/server/sharedLedgerStore.ts`、`src/server/reviewBooker.ts`、`src/ui/reviewShared.ts`。

### 2. Server 端法定全場 booker（唔好再靠訪客瀏覽器）

新增／改寫 `runReviewBooker`，喺呢啲地方跑：board SSR／loader、`/review` loader、`getSharedLedger`。流程：

1. load 共用帳本（空就 seed）
2. ingest 今日／聽日／昨日 board（用現有 server board builder，唔好靠 client `gm()` 後備做入帳）
3. 對開賽已超過 15 分鐘嘅 pending，用 GraphQL **`matchResults`** 取法定全場，再 `applyOfficialResults`
4. 先入帳再 trim（規則同 20/11：已結算最近 800；已開賽／進行中／有比分／未結算 pending **全留**；只限制未開賽無比分未來場，保留開賽最近 200 場）
5. 把更新後嘅 snapshot 回傳；唔好因為無 token 就失敗。唔好把舊種子覆蓋 GitHub 上已入帳嘅檔。

`review-results` server function **必須改用 `matchResults`**，唔好再用 `matchList` 賭完場仲留喺販售清單。

`matchResults` 要點（已核實）：

- POST `https://info.cld.hkjc.com/graphql/base/`（**唔好 GET** 個 root，會 403）
- Header：`Content-Type` / `Accept: application/json`，Chrome UA，`Referer: https://bet.hkjc.com/football/`，`Origin: https://bet.hkjc.com`
- Query 用 `football-pipeline/gql/matchResults.gql` 或 patch `src/server/hkjcMatchResults.ts` 入面嗰條
- `startDate` / `endDate` 用 `YYYY-MM-DD`（香港日曆）；範圍由最舊 pending 開賽日到今日
- 分頁：`startIndex += 20`，`endIndex = startIndex + 20`。視窗大於 20 會得到 0 行。用 `id` 去重，直到空頁或達到 `matchNumByDate.total`

法定全場擷取（`src/math/officialFt.ts`）：

- 只取 `resultType==1` 而且 `resultConfirmType>1` 而且 `payoutConfirmed` 而且比分 ≥ 0
- **法定全場 = stageId 5**，否則 100
- **禁止** 用 stageId 3（半場）或 9（加時）入帳  
  例子：20/11 艾加拉法 stage 3 係 1–2，stage 5 係 3–2；用 3 就入錯。
- `MATCHVOIDED` 唔入帳
- Board mapping：PREEVENT→`pre`；FIRSTHALF／SECONDHALF 等→`in`，`officialFt` 必須係 null（即場／半場 `runningResult` 只可寫 `home.score`／`away.score`）；`MATCHENDED`／`INPLAYMATCHENDED`→`post` + officialFt

### 3. 穩定合併（唔好用會變嘅 settledAt 做 id）

Live 覆核頁而家嘅 row id `k()` 包含 `settledAt`，pending 同之後入帳會變成兩行。共用帳本 **必須** 用穩定 id：`item.key`（`league:matchId`）。

Merge（`preferReviewItem` / `mergeReviewLedgers`）：

- 已結算永遠贏 pending；**舊 pending 唔可以覆蓋已結算**
- 兩邊都已結算：較新 `settledAt` 贏
- 兩邊都 pending：有 official／有比分／較新 `capturedAt` 優先
- `settledNByKey` 取 max，再按現有規則由 items 重算（skip pending/push，要 `ftOfficial` 同 `hit!=null`，key 用 `buildLearnKey`，所以 `1x2`→`HAD|league`）

### 4. 修復 ingest（live `cg`）

Port `ingestBoardMatches`（`src/math/reviewLedger.ts`），保留現有 `eg`／`sg` 結算函數：

- `state==="in"` 而且未有行：用 `preModel ?? model` **建立 pending**（即場 re-entry）。唔好再 skip。
- 有合法 `officialFt` 就入帳，即使 state 仲未變 `post`。
- 無 `officialFt` 嘅 live／HT／pre **唔准入帳**；只可更新非正式比分。
- 已結算行唔好被 board 覆蓋返 pending。
- 先入帳再 trim（規則同上，唔好改）。

`applyOfficialResults`／`lg`：`finished && official!==false` 先入帳；否則只更新比分。

### 5. 覆核頁 UI

- 小字改做：「資料來源：共用覆核帳本（同一條 live 連結，所有人見到同一份）。」
- 「匯出複盤」保留，下載嘅係 **共用** snapshot（格式照舊）。
- 「匯入複盤」**唔可以覆蓋共用帳本**。刪除或停用「覆蓋現有帳本」作為全域寫入。如果保留匯入，只可以做本機預覽，下一次拉共用 snapshot 就要丟棄，並寫明「匯入唔會改到其他人見到嘅帳本」。

### 6. 唔好改

- tip gate：EV≥5%／n≥15／gap≤0.18／side 6／match 2
- 校準 v2／主推重揀／modelTrust blend
- live URL 必須係 `https://dawn-apex-lagoon-gold.grok.me/`
- 唔好加假資料、唔好用 `Math.random` 填覆核或賽果
- 唔好發明 14–19/11 場次

---

## 建議直接 port 嘅檔

```
https://github.com/abcollab224/pitchedge-shared-ledger  （src/math/officialFt.ts, reviewLedger.ts, src/server/hkjcMatchResults.ts, reviewBooker.ts, sharedLedgerStore.ts, src/ui/reviewShared.ts）
唔好把 pitchedge-review-2026-11-22.json（舊 446/198）當作現行共用帳本；現行檔係 pitchedge-review-shared.json（638/6）。
```

入帳結算繼續用專案現有嘅 `eg`（patch 入面 `settleReviewPick` 只係 smoke 用）。  
Import 路徑如果 bundler 唔要 `.ts` 後綴，可以去掉，邏輯唔好改。  
舊嘅 `src/math/reviewBackup.ts`（shadowLedger 形狀）**唔好**用來 merge 呢份 11/22 種子。

可跑煙測（可選，喺 patch 目錄）：

```
cd /workspace/pitchedge-hitrate-patch && npm run smoke
```

重點：`smoke-officialFt`（FT 入帳、HT／live 唔入）、`smoke-reviewLedger`（merge 唔俾舊 pending 覆蓋、seed-if-empty、即場 re-entry、trim）、`smoke-reviewBooker`（種子 + 兩場 20/11 官方全場 → 已結算 448）。

---

## Publish

套用後 **Re-Publish / Publish 到同一個** `https://dawn-apex-lagoon-gold.grok.me/`。唔好等 GitHub token；用已公開嘅 raw URL 即可。

## 驗收（硬刷新，兩個瀏覽器／一個無痕 + 一個有舊 localStorage）

1. 兩邊覆核頁嘅 **已結算、命中率、待完場** 數字要 **完全一樣**（不再係一部機 446、一部機 372、訪客 0）。
2. **已結算必須明顯超過 446**，應接近 **638**、命中率約 **47%**、待完場只剩 23/11 未完場（入帳時係 6 場，之後可能更少）。唔好用改種子數字嚟假裝入帳。
3. 之後完場嘅場，刷新或約 45 秒 poll 後，兩個瀏覽器要一齊由待結轉入已結算。
4. 建議買門檻、校準檔不變。匯出仍然可用；匯入唔會改其他人見到嘅帳本。
5. Client JS 搜 `PITCHEDGE_LEDGER_GITHUB_TOKEN`／`ghp_`／`github_pat_` 必須係 0 命中。

## 完成回報

列：改咗邊檔、共用 raw URL、Publish 後硬刷新見到嘅已結算／命中率／待完場、live URL 是否仍然 `https://dawn-apex-lagoon-gold.grok.me/`、14–19/11 仍然缺失（預期）。
