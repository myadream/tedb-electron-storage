# tedb-electron-storage 架构与业务流程

> 适用版本：0.8.0。本文档描述**段日志引擎**（唯一引擎）的实际行为；历史 files 引擎（≤ 0.7.0，每文档一文件）已于 0.8.0 移除，其行为记录见 CHANGELOG 与 git 历史。

## 1. 定位与使用流程

本包是 [TeDB](https://github.com/tedb-org/teDB)（类 MongoDB 的嵌入式文档数据库）的**文件存储适配器**：实现 `IStorageDriver` 接口，被 tedb 的 `Datastore` 消费。tedb 负责内存中的索引与查询，本包负责所有磁盘 IO——形态是**只追加的段日志**（bitcask 式），内存中一个 keydir 维护每个 key 的最新（及上一代）记录位置。

代码分三层（驱动只依赖引擎接口，便于维护与扩充）：

```
StorageDriver（IStorageDriver 实现、per-key 队列、allKeys 镜像）
  └─ Engine（IEngine 接口 + createEngine 工厂——引擎交换点）
       └─ LogEngine（段日志实现，按业务一文件：SetItem/GetItem/Iterate/Compact/…）
```

```typescript
import {ElectronStorage} from '@qiyangxy/tedb-electron-storage';
import {Datastore} from 'tedb';

// 第 3 个参数可选：自定义数据根目录；不传则使用 OS 用户目录
const storage = new ElectronStorage('MyDB', 'users', 'D:/my-data');
const db = new Datastore({storage});

await db.ensureIndex({fieldName: 'email', unique: true});
await db.insert({_id: 'u1', email: 'a@x.com'});
await db.find({email: 'a@x.com'}).exec();
await db.update({email: 'a@x.com'}, {$set: {name: 'Alice'}}, {multi: false});
await db.remove({email: 'a@x.com'});
await db.sanitize();          // 交叉清理：索引 ↔ 存储
await db.saveIndex('email');  // 索引持久化（每次全量追加一条记录）
```

## 2. 磁盘布局与记录格式

```
<dataDir>/<db>/db/<collection>/
├─ manifest.json            # 段清单 + 持有者 pid + nextGen + checkpoint（SafeWrite 原子写）
└─ segments/seg-000001.log  # 只追加的记录流；活跃段只有一个，写满 8 MiB 滚动
```

记录 = 19 字节定长头 + 变长体（小端）：

```
0   4   crc32       覆盖其后全部字节（头部其余 + key + value）
4   8   gen        代号（集合内单调递增；同 key 第几版）
12  2   keyLen     key 的 utf8 字节数（≤ 65535）
14  4   valueLen   value 的 utf8 字节数（tombstone 为 0）
18  1   flags      0x01 = tombstone
19  ..  key bytes / value bytes（JSON 原文）
```

- 索引与文档共用同一条记录流：索引记录的 key 为 `index_<field>`，payload 即索引 JSON。
- CRC 覆盖除自身外的全部字节：崩溃撕裂的尾部与外部损坏都在解码时被拦下。
- 空索引占位符 `[{"key":null,"value":[]}]` 作为普通记录照写，由读侧 `indexCheck` 判定为"空"。

## 3. 写路径与组提交

```
value → JSON.stringify（往返校验）
  → gen = nextGen++，编码记录（CRC 内嵌）
  → 活跃段剩余不足 → 滚动：旧段 sealed + fsync → 建新段 → 先写 manifest 再落记录
  → 一次顺序 append（引擎内单 promise 链串行所有 append）
  → keydir 更新（旧位置移入 prev 槽，history: 1 时）
  → strict：组提交 sync；relaxed：1 s 兜底 sync
```

- **durability: 'strict'（默认）**：并发写共享一次 fsync——距上次 sync ≥ 2 ms / 待刷 ≥ 1 MiB / ≥ 256 条，三者先到先刷；调用方在所属 sync 返回前不 resolve。单条延迟上界 ≈ 2 ms，吞吐随并发合并。
- **durability: 'relaxed'**：不主动 fsync，活跃段每 ≥ 1 s 兜底 sync 一次——丢失窗口从"无限（OS 刷盘时机）"收敛到 ≤ 1 s。
- **恢复写恒为 strict**：修复分支把 prev 重写为新 gen 后立即 sync，不受选项影响。
- **removeItem / removeIndex**：写 tombstone（跨重启不复活），keydir current+prev 双槽清除。磁盘字节由压实回收。
- **备份语义**："past = 上一代"由 keydir 的 prev 槽承担（`logHistory: 1` 默认；`0` 只留当前代，坏即丢）——旧记录本就在段里，**更新路径没有拷贝**。
- **storeIndex**：索引就是一条普通记录；空占位符照写，读侧判定。

## 4. 读路径与 tedb 字段筛选

```
getItem(key)
  → keydir 查 O(1) → pread(segFd, off, len) → CRC 校验 → JSON.parse
  → 任一步失败 → prev 槽读取 → 可读则重写为新 gen（恢复），返回 prev 数据
              → prev 也坏/不存在 → tombstone + 删 key，返回 undefined
```

- **exists**：纯 keydir 探测（current 槽存在且未 tombstone），**零磁盘 IO、不复活**。tedb 有索引字段筛选会对每个候选 `_id` 调一次 `exists`（tedb@0.4.4 实测）——log 引擎下这条热路径是纯内存哈希查询。
- **keys()**：keydir 列表，无磁盘扫描；**iterate**：keydir 顺序 pread，回调契约 `(value, key)`，真值中断；无 `_id` 的可解析载荷静默跳过；损坏记录经 per-key 队列修复。
- **fetchIndex**：读 `index_<field>` 记录 → parse → `indexCheck` 为占位符时返回 `null`；未存储过返回 `undefined`。
- **collectionSanitize(keys)**：log 集合没有孤儿文件，tedb 不认识的 key 直接删除（各 key 走队列）。

## 5. 并发模型

1. **KeyedQueue（驱动层，按 key 串行）**：setItem/getItem/removeItem/storeIndex/fetchIndex/removeIndex/exists 按入口 key 排队；同 key 操作严格按提交顺序（past 语义成立），不同 key 并行。
2. **引擎写链（按追加序串行）**：所有 append、滚动、压实过同一 promise 链，段内记录流不会交错；失败被隔离到单个操作。
3. **GroupSync（跨写共享 fsync）**：见 §3。
4. **压实屏障**：压实运行时读路径（getItem/iterate/sanitize/clear）在 `compacting` promise 上等待；压实后仍持有旧条目的读者经"段缺失 → 修复路径"自愈，不会读到已关闭的 fd（旧段 fd 延迟关闭）。
5. **clear()**：先 `pending()` 排空驱动队列，再等在途压实，然后整体重建空状态——实例保持可用。

## 6. 恢复语义

**启动恢复**（`LogEngine.open`）：

```
读 manifest（缺失/损坏 → 全量段扫描重建）
→ pid 检查：manifest.pid 存活且非本进程 → 拒绝打开（collectionInUse）；已死 → 接管并覆写
→ 逐段 CRC 扫描：重建 keydir/prevdir（同 key 取最大 gen；tombstone 双删）
→ 活跃段撕裂尾截断（sealed 段的中部损坏停止扫描，交由读路径逐 key 修复）
→ 清理孤儿段（不在 manifest 清单内的 seg-*.log——未提交的字节）
→ 重写 manifest（含本进程 pid）
```

**运行期损坏**（单 key 自愈，走该 key 的队列）：

| 场景 | 动作 |
|---|---|
| current CRC/parse 失败 + prev 可读 | prev 重写为新 gen，返回 prev 数据 |
| current、prev 都不可用 | tombstone + 删 key（与历史 files 引擎"双坏"判定一致：prev 同样要求 CRC 通过） |
| history 0 时 current 损坏 | 无备份可恢复 → 删 key |
| iterate 途中遇到损坏 | 经该 key 队列走同一修复分支，修好才回调，修不出则跳过 |

**压实**（死字节比 ≥ `logCompactDeadRatio` 且 ≥ `logCompactMinDeadBytes`；段数 > 128 强制）：存活代按 gen 升序拷进新段（current 损坏则提升 prev）→ fsync → manifest 原子切换 → 旧段 unlink、fd 延迟关闭。中途失败（含 ENOSPC）弃新段，旧状态完好。

## 7. 大数据特征与上限

| 特征 | 说明 |
|---|---|
| 写 = 一次顺序 append | strict 组提交摊薄 fsync；relaxed 近似纯页缓存顺序写。无 per-file rename/目录 fsync |
| 文件数 = O(段数) | 10 万 × 200 B ≈ 20 MB ≈ 3 个段；10 万 key 的 cleanup 是删几个文件 |
| keydir 内存 | ≈ 120 B/key——定位 ≤ 10 万 key（约 12 MB）；100 万 key 属误用 |
| 上限 | value ≤ 4 MiB（超限拒绝）；key ≤ 65535 utf8 字节；段数软上限 128；日志总量无硬上限（压实触发点封顶 ≈ 2× 载荷） |
| key 不能含 `.` | tedb 的 `_id` 契约；索引记录占用 `index_` 前缀命名空间 |
| 多进程 | 单进程单实例：manifest pid 存活检测在打开时刻机械化（异存活 PID 拒绝打开）；同进程重复打开不检测 |
| 索引整体重写 | `saveIndex` 每次追加完整索引 JSON——建议低频持久化（tedb 侧脏标记/定时） |

## 8. 相对 0.7.0 的破坏性变更

1. **files 引擎整体移除**：`<key>.db` + `states/<key>.past` 布局不再被读写；0.8.0 只服务新建集合，无迁移路径（需要旧数据的场景留在 0.7.x）。
2. **构造选项**：移除 `engine`（唯一引擎）与 `lazyBackup`（备份语义由 `logHistory` 承担）；`durability` 与 `log*` 调参保留。
3. **公开导出移除**：`GetItem`/`SetItem`/`Clear`/`FetchIndex`/`Iterate`/`Keys`/`RemoveItem`/`StoreIndex`/`RemoveIndex`（files 驱动函数）、`pastFilePath`/`findPastFile`/`readPastFile`/`writePast`/`copyBaseToPast`/`writePastAndBase`/`removeLegacyBackup`/`removeBackup`（PastLocation 工具族）、`ClearDirectory`；`indexCheck` 保留（迁至 `src/StorageDriver/IndexCheck.ts`）。
4. **`IStorageDriverExtended`**：移除 `version`/`lazyBackup`/`engine` 字段；`allKeys`/`allKeysSet` 镜像保留。
5. **依赖**：移除 `tedb-utils`（仅 files 扫描使用）。

## 9. 测试与构建

```bash
pnpm test           # 全量（unit + concurrency + large + integration）
pnpm test:coverage  # 快速层 + 覆盖率阈值门禁
pnpm build          # Vite lib 模式 -> dist/index.js（CJS）+ d.ts
```

| 分层 | 覆盖 |
|---|---|
| `spec/unit/logEngine/` | 记录格式与 CRC、组提交、驱动契约、撕裂尾 golden 矩阵、修复/提升/双坏丢弃、manifest 重建、pid 接管、孤儿清理、滚动与压实（history 0/1、强制压实、压实中 clear） |
| `spec/unit/` | 通用 utils（SafeWrite/KeyedQueue/mapPool/CopyFile/ReadFile 族）、公开 API 工具直测、AppDirectory 平台分支 |
| `spec/concurrency/` | 混合并发读写（驱动层） |
| `spec/large/` | 3000（`TEDB_LARGE_N` 可调）条批量插入/keys/iterate/更新/删除 + 混合负载基准（跑在 log 引擎上） |
| `spec/integration/` | tedb Datastore 真实集成冒烟 |
