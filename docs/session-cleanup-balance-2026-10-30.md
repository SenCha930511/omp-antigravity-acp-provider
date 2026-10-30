# ACP session 清理與記錄保留（2026-10-30）

這次只調整 adapter；不修改 OMP source、Google runtime 或 OMP 的歷史記錄。原有 `conservative` 預設與 `timeout` 時限規則保留，新增可選的 `balanced` 模式。

## 發現與修正

1. 保守模式會無限期保留未確認可丟棄的孤立 session。平衡模式讓無 mapping、無使用者、且歸本 adapter 所有的資料，在最後使用／首次觀察到孤立狀態的較晚時間起保留 7 天。
2. OMP `AgentSession.runEphemeralTurn()` 會在沒有 `conversationKey` 的一次性請求結束時呼叫 `providerSessionState.releaseSession(id)`。adapter 以前只關閉 runtime，留下的 mapping 會一直阻止磁碟清理。現在先等 teardown，再標記已釋放、條件式移除 matching mapping。以 ACP ID 或 routing ID 的字串格式推測用途仍不足以授權刪除。
3. runtime 被閒置回收後，原本會忘記 scope 持有的 routing ID，使稍晚的最終釋放失效。現在 scope 只保留小型 ID 集合；完整 runtime 不會因此被保留。
4. 新請求若重用剛釋放的 routing ID，必須等舊 mapping 清理完成，避免接上已結束的旁路上下文。
5. 釋放標記先持久化，再移除 mapping；中途程序終止時，下次清理能繼續處理。已明確釋放的 ACP ID 不可重新取得 lease。重複的 OMP mapping 或 cleanup ownership 會保留資料，避免不完整的紀錄掩蓋另一筆 live lease。

## 平衡模式

| 資料 | 保留／回收規則 |
| --- | --- |
| 正常對話、有 mapping | 閒置未超過 `idleDays` 時保留；超過才回收，先移除 mapping 再刪檔，下次使用時從 OMP 歷史重建。容量壓力不能縮短這個窗口 |
| 使用中的 session | 保留，OMP 或 ACP PID 仍存活即受 lease 保護 |
| 確認被取代／最終釋放的一次性 session | 至少保留 1 天，容量壓力不能縮短這個窗口 |
| 其他 adapter-owned 孤立 session | 保留 7 天；超出軟上限時，孤立至少 1 天的合格資料按最舊活動優先回收 |
| 明確刪除的 OMP 記錄 | 沿用兩次檢查、至少 60 秒、搬移搜尋與 root 身分驗證 |
| 歸屬不明、未登記、路徑不安全或 mapping 不明確 | 保留 |

`/antigravity-acp cleanup balanced` 設定上述保留期，並在沒有既有值時補上 50 個 session／512 MiB 的軟上限。既有 `0` 仍代表停用上限。可用 `cleanup balanced 14` 把一般孤立資料改留 14 天；`recoveryDays` 可在設定檔調整。大量正常對話可以超出軟上限。
後續調整：`balanced` 原本對所有 mapped session 無條件保留，導致長期使用後磁碟只增不減。現在 mapped session 也套用同一個 `idleDays` 視窗（預設 7 天），但仍要求：沒有 live lease、mapping 唯一且可證明歸屬、回收前先條件式移除 mapping。`conservative` 與 `timeout` 維持原本語意，mapped session 一律不刪。重建成本見 README 的 context transfer 章節：重播受單步 188,000 bytes 限制，長對話重開時 OMP 可能需要先 compaction。

回收副本保留在原有 ACP 儲存位置，只是延後刪除，沒有新增還原介面。OMP 歷史記錄不會被改寫；ACP 專有推理與 checkpoint 在真正刪除後無法保留。已驗證的 source 缺失清理仍有自己的規則，不會被平衡模式當成普通孤立資料處理。

## 實際磁碟觀察

檢查當下本機 ACP 資料約佔 86.35 MiB allocated space；主 profile 登記 36 個 owned session，其中 15 個有 mapping、21 個沒有。邏輯檔案大小與 APFS allocated space 不同，不能把測得的邏輯 bytes 當成確切釋放空間。

本輪沒有修改使用者的清理設定或刪除既有 session。平衡策略保留觀察窗口，不因一次掃描看見較舊的 last-used 時間就立即大量刪除。

## 離線驗證

- 單元／整合 regression：保留期限、重啟、重複 confirmation、容量壓力、live lease、unknown/shared mapping、更新 mapping 競態、idle eviction 與最終釋放順序。
- 真實 OMP CLI 搭配隔離 fake ACP transport：session 切換、fresh、fork、tree、取消、compaction、程序重啟，以及透過 extension context 呼叫真正 `runEphemeralTurn()`，檢查一次性 mapping 被移除、副本仍保留、主要對話不受影響且下一個請求只發送一次。
- `npm run check`、`npm run test:omp-sessions`、`npm run test:packed`；packed 檢查包含 offline OMP catalog load。

驗證結果：176 項 regression 全數通過；`npm run check`、真實 OMP 18.14.0 的離線 session 測試、packed 安裝／offline catalog load 與 `git diff --check` 均通過。OMP RPC 使用 24 次 fake prompt 呼叫，程序重啟後再確認一次 follow-up；Google inference 為 0。

以上不測量帳號配額或線上推理效能。
