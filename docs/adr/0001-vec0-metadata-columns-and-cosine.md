# vec0 使用 metadata 列而非辅助列，并声明 distance=cosine

sqlite-vec 的 vec0 虚拟表有三类列：向量列、辅助列（`+col`）、metadata 列（plain `col`）。实测（vec0 v0.1.9 / sqlite 3.53.2）表明：**辅助列不可在 KNN 的 WHERE 或 DELETE 的 WHERE 中过滤**（报 `illegal WHERE constraint on a vec0 auxiliary column`），而 **metadata 列可以**。因此 `asset_vec` 用 metadata 列 `asset_id text, field text`（不带 `+`），以支持 KNN 按可见性子查询过滤、按 field 过滤、以及 `DELETE FROM asset_vec WHERE asset_id = ?` 直接删除。

距离度量在 CREATE 里声明为 `embedding float[D] distance=cosine`（小写、带 `=`；`DISTANCE_COSINE`/`distance_cosine` 等写法不被解析，默认度量是 L2）。声明 cosine 后 vec0 内部归一化，对非单位向量也返回真实 cosine 距离，**无需在 JS 里做单位化**，也无需 rowid 两步删（按 metadata 列直接 DELETE 即可）。

KNN 支持子查询过滤：`WHERE embedding MATCH ? AND k=N AND asset_id IN (SELECT asset_id FROM <可见集>)`，这是可见性预过滤（ADR-0002 之外的能力）的基础。
