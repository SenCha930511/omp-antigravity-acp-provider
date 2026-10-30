# 程式碼與資源使用檢查（2026-10-30）

基準：`ae4ff654aac5fedf477def40f8b875a4a1b39161`（0.1.26）。修正位於工作目錄，尚未發布或更新版本號。後續針對 OMP 操作與 session 隔離的檢查另見 [session 切換稽核](session-transition-audit-2026-10-30.md)。

檢查範圍包含 adapter、runtime pool、session 映射與清理、context transfer、模型目錄、命令、fingerprint 與建置相容層。原始 vendor 程式碼維持原樣；執行通訊維持官方 Antigravity ACP。

## 已修正的問題

| 優先度 | 問題與觸發條件 | 修改與驗證 |
| --- | --- | --- |
| P1 | 清理程序只檢查映射檔是否為陣列；`[{}]` 或錯誤型別的紀錄可能讓已到期的 session 被視為無映射而刪除。 | 透過 session store 讀取並驗證整份映射；損壞或不支援的紀錄阻止刪除。新增逐筆損壞映射測試。 |
| P2 | `acquire()` 先以閒置身分套用 LRU 上限，隨後才建立執行租約；新工作會過早淘汰其他可重用 runtime。 | 先建立租約，再計算真正閒置的項目；保留原有上限與忙碌保護。 |
| P2 | 兩次並行 `closeAll()` 中，後者可能在前者仍進行資源釋放時返回。 | 所有 teardown 都加入既有的待完成集合；新增受控 Promise 測試，確認兩者均等待。 |
| P2 | cleanup 移除 unowned 紀錄後，其 `touched` Map 項目仍持續保留。 | 成功寫入 registry 後，移除不再有紀錄的活動項目；保留尚未持久化的有效活動資料。 |
| P2 | dynamic catalog、`currentModels` 與 model lookup 狀態不同步；重新設定或快取命中可能留下舊限制。 | 統一安裝完整投影並使舊快取失效；快取依設定內容識別，能偵測原物件修改。 |
| P2 | 以已投影的模型再次套用設定，移除 override 後仍沿用舊限制；投影或磁碟寫入失敗也可能留下部分新目錄。 | 保留原始模型限制；完整驗證後再更新記憶體狀態，refresh 則先完成原子寫入。加入失敗投影與失敗持久化測試。 |
| P3 | 沒有 cache 檔時，每次 dynamic model 查詢都重新產生 fallback 投影。 | 缺檔也納入快取，設定或檔案狀態改變時失效；相同查詢重用投影。 |
| P2 | 超大歷史先被完整轉成 JSON，再被大小檢查拒絕，產生大量可避免的字串配置。 | JSON replacer 在編碼各字串前累計保守下界並提早中止；仍保留精確的最終文字大小檢查。 |
| P2 | 大量 content blocks 經 `push(...blocks)` 展開時，可能先產生 `Maximum call stack size exceeded`。 | 改為迴圈附加，順序及物件內容保持一致；150,000 blocks 測試確認收到正常的 context overflow。 |
| P2 | wire budget 低估嵌入歷史 JSON 在 resource 字串內再次跳脫的大小。 | 計算實際 prompt JSON envelope 與跳脫字元，圖片 base64 仍獨立計數；補上引號密集輸入測試。 |
| P2 | 大於 `2147483647` 的 idle timeout 被 Node timer 轉為 1 ms，導致提早關閉或密集重試。 | 設定時拒絕超出 timer 範圍；預設 300,000 ms 與 `0` 停用行為不變。 |
| P2 | `usage off extra`、`debug on extra`、`native-tools disabled extra` 會忽略多餘參數並執行。 | 在設定寫入或 runtime 關閉前檢查參數數量。 |
| P2 | context setting 的 `constructor` 等繼承鍵可能通過驗證；名稱為 `toString` 的模型可能取得繼承函式並修改其屬性。 | 只接受設定表的 own keys；模型名稱使用 own-property lookup 建立獨立設定物件。 |

## 功能相容性

- 預設閒置上限、timeout、usage 模式、清理政策、模型選擇、工具與權限路由維持原設定。
- 256 組正常輸入逐項比較基準版本與修改版本的完整 `buildPromptParts()` 結果，全部相同。案例涵蓋冷重播、暖 session、新請求、工具結果延續、圖片、中英文、換行與引號。
- 既有 fingerprint、取消、compaction／重建、工具／permission 多批延續、持久化與跨程序租約測試繼續通過。
- 行為修正集中於損壞資料、錯誤命令、超出 timer 範圍和超出實際 payload 限制的輸入；既有檔案格式不變，未刪減正常請求內容。

## 離線資源比較

環境：macOS arm64，Node v26.12.1。每個耗時測項量測 9 組，先暖機，並在每組開始前 GC；修改前後使用分開的程序。所有內容為合成資料，沒有 ACP 程序或模型請求。

| 測項 | 修改前 | 修改後 |
| --- | ---: | ---: |
| 拒絕 32 MiB 歷史：每次 wall time 中位數 | 22.867 ms | 0.720 ms |
| 同測項：每次 CPU time 中位數 | 22.627 ms | 1.612 ms |
| 同測項：呼叫前後觀測到的最大額外 JS heap | 67,119,096 bytes | 9,960 bytes |
| 小型正常輸入：每次 wall time 中位數 | 0.0065 ms | 0.0143 ms |
| 保留兩個主要 session、開關 100 個暫時 session：runtime 物件建立次數 | 202 | 102 |
| 缺少磁碟 cache 的 100 次相同 catalog 查詢：fallback 產生次數 | 100 | 1 |

精確驗證在小型輸入增加約 8 微秒，換取正確的 wire 大小判斷與提早拒絕大型內容。runtime 數字是本地物件生命週期計數，未實際啟動 Google 程序；修正會保留原先上限允許的暖 runtime，以減少重建，因此不宣稱每種情境的總 RAM 都會下降。

heap 數字是 GC 後到呼叫返回時的差值，**不是程序峰值 RSS**；32 MiB 原始輸入已在量測前建立，仍需記憶體。這些數字不能代表模型推論速度、整個 OMP／Google 程序的 CPU／RAM、帳號配額或 cache 命中率。

重現方式：

```sh
node --expose-gc scripts/benchmark-resource-management.ts ae4ff654aac5fedf477def40f8b875a4a1b39161
```

腳本只用 `git show` 讀取指定版本，於記憶體中轉譯比較，不改寫 checkout。原始版本需存在於本機 Git 歷史。

## 驗證

- `npm run check`：第一輪 140 個測試；加入 session 稽核後為 162 個測試，另包含 build、cleanup、continuity／graceful cancellation、load graph、工具與離線認證命令整合測試。
- `npm run test:auth`：隔離的離線登入／登出、忙碌保護及 OMP logout 跟隨測試。
- `npm run test:packed`：獨立 consumer 安裝、無 production dependency、supervisor smoke，以及停用 ACP 的實際 OMP model catalog 載入。
- 上述 benchmark：256 組完整 prompt 相等，並產生資源比較結果。
- `git diff --check`。

未執行 live inference。官方 Google runtime 的真實資源消耗與長時間執行下的收益尚未量測；完整磁碟掃描仍依 session artifact 數量成長，本次維持其安全檢查與狀態計算行為。
