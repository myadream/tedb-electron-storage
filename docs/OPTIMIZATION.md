# 优化分析报告（代码 + 业务）

> 基于 0.3.0（修复 + 并发层之后）的代码。按"正确性优先、性能其次"排序；每项标注改动面与风险。
> **状态更新（0.4.0）**：#1、#2、#4 已实施（见文末"已实施记录"）。
> **状态更新（0.6.0）**：#6 已实施（默认开，`{lazyBackup: false}` 保留旧语义）；存在性探测 stat 化、SafeWrite 合并系统调用、removeBackup 瘦身、IO_LIMIT 32→128 一并落地。before/after 见文末"10 万数据集基线"。

## 总览

当前每次 `setItem`（更新场景）的实际 IO：读 base 判断存在 → 读 base + parse + 写 past（临时+fsync+rename）→ 写 base（临时+fsync+rename）。合计 **1 读、4 次写、2~3 次 fsync**。崩溃安全（原子 rename + fsync）是刻意设计，但所有场景都付全价是可优化的起点。

| # | 优化项 | 类型 | 预期收益 | 风险 |
|---|---|---|---|---|
| 1 | CopyFile 静默失败 | **正确性** | 修复备份不变量被破坏的隐患 | 低 |
| 2 | durability 等级选项（strict/relaxed） | 性能 | 写吞吐 3~5× | 低（可选项） |
| 3 | keys() 文件名推导 key | 性能 | 冷启动 keys() 从 O(n·读) → O(readdir) | 低 |
| 4 | allKeys 用 Set 伴随维护 | 性能 | 10 万 key 时写查重 O(n)→O(1) | 低 |
| 5 | 批量接口 setItems | 性能 | 初始导入 2~4× | 中 |
| 6 | 首写惰性备份 | 性能/磁盘 | 插入场景 IO 与磁盘占用 ~减半 | 中（弱化首写恢复） |
| 7 | 错误码保真（cause/code） | 可维护性 | 上层可按 code 分支处理 | 低 |
| 8 | 跨实例队列文档化/模块级化 | 正确性 | 多实例同目录安全性 | 低 |
| 9 | GetItem LRU 读缓存（可选开关） | 性能 | 高频同 key 读场景 | 中（失效与队列集成） |
| 10 | 索引持久化防抖（业务层） | 性能 | 高频 saveIndex 场景 | 低 |

## 1. CopyFile 静默失败（正确性，建议优先修）

`src/utils/CopyFile.ts` 的实现是"读源 → safeParse → 可解析才写目标，**不可解析则静默 resolve**"。后果：`setItem` 更新路径中 base 内容若恰好不可解析（外部损坏瞬间），`CopyAndWrite` 的 copy 步骤等于没执行，`past` 保持旧值而主流程继续写 base——"past 是 base 的上一代"这一备份不变量被无声破坏，且无任何日志/报错。

建议：改为 `graceful-fs` 的 `copyFile`（内核级拷贝，附带性能收益），失败**上抛**；调用方（备份路径）失败时应中止本次写而不是继续。

## 2. durability 等级选项（性价比最高的性能项）

SafeWrite 目前无条件执行 fsync(临时文件) + fsync(目录)。加构造选项：

```ts
new ElectronStorage(db, collection, dir, {durability: 'strict' | 'relaxed'})
// 默认 'strict'（现行为）；'relaxed' 跳过 fsync，保留原子 rename
```

- **strict**：断电也不丢已确认的写（现行为）。
- **relaxed**：防撕裂/防半写（rename 原子性仍在），断电可能丢最后数百 ms 的写——与 OS 页缓存同级别的承诺，绝大多数桌面应用可接受。

Windows 上 fsync 成本高（实测 3000 条插入 ~30s 主要是 fsync），relaxed 预计 3~5×。实现集中在 SafeWrite 一处加开关即可。

## 3. keys() 用文件名推导 key，跳过全量读

`Keys.readAllDir` 对每个 `.db` 文件 read + JSON.parse 只为取 `parsedData._id`——而 key 就是文件名（`<key>.db` 去后缀）。改为 readdir 直接推导 key，仅当某文件需要恢复校验时才读内容。10 万文件的冷启动 keys() 从"10 万次读+解析"降为一次 readdir + 字符串处理。tedb 契约中 key === _id，正常数据文件名与内容 _id 必然一致；不一致本身就是损坏，走恢复路径。

## 4. allKeys 查重 O(n) → O(1)

`SetItem` 每次写用 `allKeys.indexOf(key)` 查重；`GetItem`/`RemoveItem` 恢复路径用 `filter` 重建数组。10 万 key 时每次插入的 indexOf 是 10 万次比较。内部维护伴随 `Set`（对外仍暴露 `allKeys: string[]` 保持兼容），写查重与移除都 O(1)。改动集中在 Driver + 几个恢复点。

## 5. 批量接口 setItems（导入场景）

tedb 的 `insert` 逐条调用 `setItem`，10 万条导入 = 10 万次完整写路径。加 driver 级批量方法（不影响 `IStorageDriver` 最小契约，纯增量）：

```ts
setItems(entries: Array<[string, any]>): Promise<any[]>
```

- 批内同 key 只落最后一版（写合并）；
- 骨架目录一次性确认；
- 跨 key 有界并发（复用 mapPool），per-key 仍走队列保序；
- 收尾统一一次目录 flush（POSIX 下 N 个 rename 只需最后一次 dir fsync）。

结合 #2 relaxed 与 #6，初始导入整体可到原来的 5~10×。

## 6. 首写惰性备份

首次写入当前同时写 base + past（内容相同，纯冗余）。改为：首写只写 base；第二次更新时才产生 past。插入密集场景 IO 与磁盘占用近似减半（现布局数据在磁盘上天然 ×2）。代价：首写后、首次更新前发生"原子写之外的外部损坏"（坏块、同步工具误操作）时无备份可恢复——在原子写已消除半写损坏的前提下，这是一个可论证接受的弱化，建议做成选项（`lazyBackup: true`，默认关）。

## 7. 错误码保真

各 utils 的错误包装 `new Error(':::Storage::: xxx Error. ' + err.message)` 丢弃了 `err.code`，上层永远拿不到 EACCES/ENOENT/EPERM 等可编程判断的错误码（`renameWithRetry` 依赖的 code 恰好因为在包装之前检查才幸存）。统一改为保留 `code`（和 ES2022 `cause`）。

## 8. 跨实例协调

`operationQueue`（per-key 串行）是**实例级**的；`SafeWrite` 的 per-path 队列是**模块级**的（跨实例共享）。两个 `ElectronStorage` 指向同一目录时，同 key 的读写只被 SafeWrite 层部分串行化，读自愈与写仍可能竞争。短期：文档明确"一个集合目录一个实例"；长期：把 operationQueue 也提升为模块级（按 `collectionPath + key` 复合键）。

## 9. GetItem LRU（可选，默认关）

persist-only 设计下每次读都走磁盘。OS 页缓存已兜底，但高频读同一 key（如查词 UI 反复读同一条）可加小容量 LRU。写路径必须在队列内同步失效缓存，复杂度不小——建议仅在实测成为瓶颈时开启，默认保持无缓存语义。

## 10. 索引持久化防抖（业务层）

`storeIndex` 每次全量重写索引文件，成本随集合线性增长。驱动力应放在 Collection/业务层：脏标记 + 定时/关闭时持久化（README 已建议低频持久化）。驱动层维持现状，不做分片/增量格式（破坏兼容，收益不明确）。

## 已在 0.3.0 完成的相关项（无需再做）

- 目录扫描的正则 `new RegExp` 每次构造 → 已改 `includes` + `.endsWith('.db')`；
- 无界 `Promise.all` 扫描 → 已改有界 mapPool（IO_LIMIT=32）；
- keys() 计数启发式 → 已改文件名集合精确比对；
- 非原子 truncate-write → 已改临时文件 + rename；
- `EnsureDataFile` 空文件预创建窗口 → 已移除。

## 已实施记录（0.4.0，2026-09-30）

### #1 CopyFile 静默失败 —— 已修复

`src/utils/CopyFile.ts` 改为 `graceful-fs` 的 `copyFile`（内核级字节拷贝）：

- **不再有 JSON 可解析门控**：备份保存上一代的精确字节，损坏与否由恢复路径判定（恢复路径本就用 safeParse 判定，语义不变）。
- **任何 IO 失败（含源缺失）上抛**：`CopyAndWrite` 的 copy 步骤失败 → 整个 `setItem`/`storeIndex` reject，写中止，不再无声继续。
- 附带性能收益：备份拷贝从「全量读 + 全量写 + fsync」变为一次内核拷贝——更新路径的 fsync 从 2 次降到 1 次（这解释了 #2 在 update 路径提速比 insert 低）。
- 回归：`spec/unit/copyFile.spec.ts`（字节保真复制 / 缺失源 reject / base 损坏时 setItem 的备份不变量）。

### #2 durability 等级选项 —— 已实施

- `new ElectronStorage(db, collection, dir?, {durability: 'strict' | 'relaxed'})`，默认 `strict`（行为不变）。
- `relaxed`：`SafeWrite` 跳过临时文件 fsync 与目录 fsync，保留原子 rename——防撕裂不丢，断电可能丢最后数百 ms 的写。
- 恢复写（Keys 自愈重写）固定 strict。
- 实测（Windows，`spec/large/benchDurability.spec.ts`，同机同盘对比）：insert **3.0×**（22.7→7.5ms/op），update **1.9×**（9.6→5.2ms/op）。
- 回归：`spec/unit/durability.spec.ts`（relaxed 下 insert/update/index/remove 全往返正确、无 tmp 残留）。

### #4 allKeys 查重 O(n)→O(1) —— 已实施

- `Driver` 维护 `allKeysSet: Set<string>` 伴随 `allKeys: string[]`（数组保留对外兼容与顺序）。
- 新增 `trackKey`/`untrackKey`；`SetItem` 查重改 Set，GetItem/RemoveItem/CollectionSanitize 的 7 处 `filter` 重建数组改为 `untrackKey`（删除路径 splice 单次）。
- 实测：10 万 key 已跟踪时 1000 次更新 4.95ms/op，与 2 个 key 时无差异——查重成本已不可测（原 indexOf 为每写 O(n) 字符串比较）。
- 回归：`spec/unit/allKeys.spec.ts`（去重、删除、外部删除自愈、sanitize、clear 五个同步点）。

## 已实施记录（0.6.0，2026-09-30）

### #6 首写惰性备份 —— 已实施（默认开）

- 构造选项 `{lazyBackup}`（默认 `true`）：首写只落 base，past 由该 key 首次更新创建；`false` 恢复旧首写双写。`StoreIndex` 非空首存同处理；空占位符语义不变。
- "base 缺失但备份目录存在"恢复分支保持双写不变；never-updated key 的恢复走既有"无备份目录"分支（双删 + untrack）。
- 回归：`spec/unit/lazyBackup.spec.ts`（两种模式矩阵）；`setItem`/`removeItem`/`index`/`recoveryMatrix` 首写断言同步更新（需要 past 的夹具改为种两代）。

### 一并落地的写/读路径瘦身

- **存在性探测 stat 化**：`SetItem`/`StoreIndex`/`RemoveItem`/`RemoveIndex` 判存在改 `safeStat`（ENOENT→false，其余错误 reject，语义与原全文读等价），每次写/删省一次整文件读。
- **SafeWrite 合并系统调用**：单次 `open` 完成 write + fsync + close（旧流程经 `FlushStorage` 二次打开临时文件），POSIX strict 保留 rename 后目录 fsync，relaxed 行为不变。
- **removeBackup 瘦身**：删备份目录不再先读 past（`UnlinkFile` 本就容忍 ENOENT）。
- **IO_LIMIT 32→128**：keys/iterate/sanitize/clear 扫描并发提高；10 万文件全量扫描实测 < 5s。

## 业务侧（消费方）建议

若此包被 obsidian-language-learner 采用作存储驱动：单词库 1~10 万条，"保存生词"是单条 setItem + 全量索引重写——建议 relaxed durability、导入用批量接口、索引只在关闭/定时持久化。自定义目录参数已支持 vault 内路径；Obsidian 桌面端 Node 环境可直用 graceful-fs。

## 10 万数据集基线（2026-09-30，0.5.0 代码，spec/large 基准）

`TEDB_LARGE_N=100000`，Windows/NTFS，strict durability，mapPool 64 并发。基准文件：`benchSingleMethod.spec.ts`（单方法隔离计时）、`benchLinked.spec.ts`（联动：10 轮 add/update/remove/query 交错混合负载 + 跨轮 read-your-write 断言），共享工具 `benchShared.ts`。

| 相 | 单方法隔离 | 联动混合 |
| --- | --- | --- |
| insert 10 万条 | **665 s（150 op/s，6.65 ms/op，占套件 85%）** | 592 s（169 op/s） |
| update 1 万条 | 29.4 s（340 op/s，2.94 ms/op） | 混合轮 1 万条，avg 253 ms/op\* |
| remove 4 千条 | 7.5 s（534 op/s） | 混合轮 1 万条，avg 224 ms/op\* |
| 点读 getItem | 1000 条 0.09 s（11.2k op/s） | 混合轮 1 万条，avg 74 ms/op\* |
| keys()（缓存热路径） | 0.17 s | 每轮账目校验 |
| iterate 全量扫描 | 8.7 s（11.6k op/s） | 8.6 s |
| cleanup（clear+rmSync） | 64 s | 70 s |

\* 联动混合的 avg ms/op 是 64 并发下**含排队等待**的单条延迟；混合吞吐看 wall：10 轮共 4 万 op 用时 120 s ≈ 334 op/s。

结论：

- **insert 是唯一的大头（~85%）**。首写双写 base+past（2 次 SafeWrite = 2 次 fsync + 1 次 mkdir），与 update 单写路径（CopyFile + 1 次 SafeWrite，2.94 ms/op）约 2.26 倍的差距与双写结构完全吻合 → **#6 首写惰性备份是杠杆最大的项**，插入路径预期 ~2×。
- iterate / keys / 点读实测均非瓶颈（10 万文件全量扫描仅 ~9 s）；#3 的收益只剩冷启动 keys()。
- 单套件 10 万规模总时长 ~13 min（insert ~11 min + 更新/删除/清理杂项）。
