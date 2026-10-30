# OMP session 操作與 ACP 隔離稽核（2026-10-30）

以「不能串錯對話，不能把已接受的同一輸入再送一次」作為主要判定。ACP ID 可以改變；當狀態不明、版本無法信任或映射衝突時，優先用 OMP 保留的上下文建立新 session。

## OMP source 中容易漏掉的契約

讀取的 checkout：`/Volumes/T7/Code/omp/oh-my-pi`，Git commit `6f3fbc94c567c0ac619c013dd15d718356eecba1`。其 coding-agent package metadata 標示 18.13.2。這份 source 與安裝的 CLI 不視為同一 build；整合測試自行記錄 `omp --version`，本次先後測到 18.13.3 與 18.14.0，最後完整流程在 18.14.0 通過。沒有修改 OMP source 或 adapter 的 vendor 原始碼。

| Source 位置（相對 OMP checkout） | 觀察到的行為／對 adapter 的影響 |
| --- | --- |
| `packages/coding-agent/src/session/agent-session.ts`：`newSession`、`switchSession`、`fork` | 成功後發出 `session_switch`，不等於程序關閉；切換也能取消或失敗回復。 |
| 同檔：`#branchIntoNewSession`、`navigateTree` | branch／entry fork 發出 `session_branch`；tree 是 `session_tree`，可能只換 leaf 而保留同一個 routing ID。單靠 switch 事件無法判斷所有歷史變動。 |
| 同檔：`#activeProviderSessionId`、`freshSession`、`resetContext` | UI 對話 ID、provider routing ID 可以不同；fresh／clear 可以保留對話檔案，卻換 provider 身分。 |
| 同檔：`#closeAllProviderSessions`、side-request 呼叫 | OMP 透過 `providerSessionState.close()` 關閉 provider 狀態，旁路結束時也可能呼叫 `releaseSession(id)`。adapter 原本未參與這個契約。 |
| 同檔：side-request options；`session-maintenance.ts`：speculation | 旁路可使用 `:side:`、`:side:conversation:` 或 `:spec:` routing ID，同時保留主要對話的 cache key。cache key 不能拿來選 ACP session。 |
| `packages/coding-agent/src/extensibility/extensions/types.ts`；`packages/ai/src/types.ts` | provider 會收到陣列形式的 system prompt 與 live AgentTool wrappers；後者帶有 mutable host、計數器及可執行物件。 |
| `packages/coding-agent/src/session/session-maintenance.ts`；`packages/agent/src/compaction/compaction.ts` | 手動／自動摘要可能沿用主 routing ID，改變 system prompt、歷史形狀或工具；推測摘要另有 routing ID。必須以實際輸入邊界判斷能否重用。 |

## 已重現並修正

1. **並行相同快照重送**：兩個同時進來的相同 user snapshot 原本會依序執行兩次；第二次還可能因缺少第一個輸出的 assistant boundary 而冷重建。現在第二個呼叫明確拒絕，第一個 writer 繼續完成，總共只 dispatch 一次。不同輪次主動輸入相同文字不受影響。
2. **工具 host 狀態污染 fingerprint**：實際 OMP 的工具物件會帶入整個可變 host。A → B → A 的歷史明明相同，hash 卻因 host 狀態不同而改變，造成不必要重播；循環物件也可能破壞序列化。現在只保留 bridge 使用的 name／description／parameters，system tool deltas 也相同處理；schema 的真正變更仍會偵測。
3. **fresh／reset 生命週期缺口**：原本只依 `session_shutdown` 的 UI 對話 ID 關閉 runtime，沒有處理 OMP provider-state 介面。現在接上 close／releaseSession，等待 teardown，並擋下舊 scope 延遲中的 dispatch。重載 adapter 也會先關閉前一代 scope。
4. **model 變更被 continuation 提早返回略過**：ACP prompt 停在工具／permission 時，新的模型選擇可能未套用就繼續舊 prompt。現在模型不同時重建；一般完成後的 model／reasoning 變更仍使用已確認的 selector。
5. **cwd 改變仍沿用原工作區**：相同 routing ID 搬到不同 cwd，舊 warm binding 原本未檢查工作目錄。現在會重建，不能沿用原 workspace。
6. **映射歸屬不明**：同一 OMP ID 多列，或多個 OMP ID 指向同一 ACP ID，原本可能選到第一列。現在這些情況不提供恢復候選；新增映射也不能占用其他 OMP ID 已映射的 ACP ID。
7. **重新登入仍保留前一帳號映射**：fresh Google login 原本清 credentials 與 runtime，卻沒有清 session 映射。現在先清映射，保留 OMP 對話供新 backend 重建。
8. **陣列 system prompt 被逗號串接**：原本 template interpolation 會將段落陣列變成逗號分隔。現在以空行保留段落。

既有的 dirty／舊 checkpoint 重建、跨程序租約、conditional mapping removal、assistant boundary 與取消確認規則保留。

## 測試覆蓋

「實際 OMP」指已安裝的 CLI、真正的 extension registration、provider wrapper、built runtime、磁碟 session store 和 RPC 操作；**ACP transport 是隔離的假實作**，沒有啟動 Google runtime 或消耗模型配額。

| 情境 | 執行層級 | 檢查重點 |
| --- | --- | --- |
| A → new B → resume A | 實際 OMP RPC＋runtime 測試 | 不能用 B 的 backend／上下文；若重用已確認 A，只送新的 delta。冷重建也允許。 |
| fork、branch 編輯舊 user、tree 回退 | 實際 OMP RPC＋runtime 測試 | 新 lineage 隔離；同 ID 的歷史縮短或同長度修改也不能沿用錯誤 accepted boundary；丟棄分支不能重新出現在輸入。 |
| `/fresh` 保留對話檔案但換 routing ID | 實際 OMP RPC | 舊 runtime 關閉，新 scope dispatch 不得誤用；與 UI ID 不同的 runtime 在 shutdown 也會關閉。 |
| 切換目標檔案損壞、切換失敗 | 實際 OMP RPC | 回復原 session；下一個正常輸入只 dispatch 一次，不混入失敗目標。 |
| model、permissions 變更 | 實際 OMP RPC＋runtime 測試 | 下一次 prompt 使用選中的模型／mode。 |
| off → high → max、工具等待中改 model | built runtime | 正確 selector route；等待中的舊模型 prompt 不可偷渡新選擇。 |
| Esc／abort → new → resume 原對話 | 實際 OMP RPC＋graceful cancellation suite | 不串其他對話，不把已中斷的 user request 重新當成新請求。 |
| 手動 compact、automatic compact | 實際 OMP RPC | 摘要真的經過 adapter；重建後下一個 user request 出現一次。auto 測試以一次合成 occupancy 觸發。 |
| 程序關閉後 `--resume` | 第二個實際 OMP 程序 | 下一個請求只 dispatch 一次；歷史只可作 reference，不能當 current request 再執行。 |
| shutdown／同 ID teardown／idle LRU race | 實際 OMP shutdown＋lifecycle/runtime 測試 | 等待前任釋放；合法新請求不因 idle eviction 遺失；舊 scope 的延遲請求不能穿越 reset。 |
| side request 結束、planning 與 main scope、adapter reload | lifecycle 契約測試 | 只關閉正確 scope／ID；不誤關主要對話；替代 adapter 等前一代 teardown。 |
| 舊版或 dirty checkpoint、失敗儲存／移除、跨程序競爭 | 既有 continuity/store suite | 無可靠證明就重建或拒絕；舊 turn 不得重新寫回已退休的映射。 |
| 相同快照並行、checkpoint blocked 時重複進入 | built runtime | 第一個回應不中斷，第二個呼叫收到明確錯誤，總 prompt dispatch 為 1。 |
| 下一輪主動輸入相同文字 | built runtime | 正常接受；不使用全域文字去重。 |
| 外來 ACP session ID 的文字／permission | built runtime | 不寫入當前 writer、不彈出當前對話的 permission；外來 permission 回覆 cancelled。 |
| 映射重複、登入換帳號、cwd／system policy 改變 | store／離線 auth／runtime | 不挑歧義映射、不恢復前一帳號 session、不保留舊工作區或規則。 |

本次完整 suite 為 **162 個測試全部通過**；`npm run check` 另執行 cleanup、continuity、load graph、工具及離線 auth 整合。實際 OMP 18.14.0 流程記錄 22 次假 transport prompt（包含摘要），第二個程序恢復後額外 1 次；各處均檢查新請求邊界，且程序結束後每個已開啟的假 connection 均有 close。

```sh
npm run check
npm run test:omp-sessions
npm run test:packed
```

第二個命令需要本機 OMP；可用 `OMP_ACP_TEST_OMP_BIN` 指定另一個 CLI 路徑。測試使用暫存 workspace／agent dir／Gemini dir 和假 credentials storage，不碰使用者的對話或 Google account。流程完成或斷言失敗時會清理暫存檔。

## 證據界線

- 沒有進行 Google live inference、真實 MCP 工具操作或互動 TUI 按鍵 E2E；不宣稱模型一定遵守歷史 reference 指示，也不把假 transport 視為真實伺服器測試。
- `/clear`、`/btw`／推測摘要的具體 UI 路徑以 source review 和共用 routing/lifecycle 契約測試覆蓋；未宣稱本次逐一操作其 TUI。手動／自動 compaction、fresh 等表中標示的 RPC 路徑則有實際 CLI 證據。
- 對無法確認是否被遠端接受的 transport failure，保留既有 dirty checkpoint 重建規則。官方 ACP 沒有這裡可用的通用 exactly-once 證明，不能保證跨任意網路故障永遠不會重試；本次確認的是 client 不會重複 dispatch 相同並行快照、不誤用歧義或其他對話的映射。
- 未發布套件、未更新全域安裝；變更留在專案工作目錄。
