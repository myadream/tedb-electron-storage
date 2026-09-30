# AGENTS.md — tedb-electron-storage

给 AI 编码代理的项目须知。本包是 [TeDB](https://github.com/tedb-org/teDB)(类 MongoDB 嵌入式文档库)的**文件存储适配器**:tedb 负责内存索引与查询,本包负责全部磁盘 IO。Electron/Node 环境,TypeScript。

## 常用命令(用 pnpm,不要用 npm/yarn)

```bash
pnpm install
pnpm typecheck        # tsc --noEmit,每次改动后必须过
pnpm test             # 全量(unit + concurrency + integration + large,约 60s)
pnpm test:coverage    # 快速三层 + 覆盖率阈值门禁(约 22s),每次改动后必须过
pnpm test:large       # 仅大规模/耐久性基准(TEDB_LARGE_N 可调规模)
pnpm build            # vite lib 模式 -> dist/(CJS bundle + d.ts)
```

覆盖率阈值在 `jest.config.js`(语句 95 / 分支 88 / 函数 92 / 行 95),`test:coverage` 低于阈值会直接 fail——新增源码分支时必须同步补测试。

## 代码地图

```
src/
├── StorageDriver/        每个驱动方法一个文件,Driver.ts 的 ElectronStorage 类组装它们
│   ├── Driver.ts             类定义 + per-key operationQueue 入口 + ensureDirs
│   ├── SetItem/GetItem       写入 / 读取(含损坏自愈)
│   ├── Exists.ts             非破坏性存在性探测(不复活数据)
│   ├── Keys/Iterate          集合扫描(mapPool 限并发 128)
│   ├── StoreIndex/FetchIndex/RemoveIndex   索引持久化(文件名加 index_ 前缀)
│   └── CollectionSanitize/Clear
├── utils/                fs 的 Promise 封装;SafeWrite(原子写)、KeyedQueue(串行化)、
│                         pool(mapPool)是并发模型核心
├── AppDirectory/         按平台决定数据根目录(自定义 dir 优先)
└── types/                StorageDriver_BaseInterface.ts 等
```

详尽的数据流与并发模型见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 磁盘布局契约(测试和恢复逻辑都依赖它)

```
<dataDir>/<db>/db/<collection>/<key>.db                       当前数据(base)
<dataDir>/<db>/db/<collection>/`v0.0.1/states/<key>/past      上一代数据(backup)
                               index_<key>.db                 索引 base / backup 同理
```

- `version` 常量是 **`` `v0.0.1 ``(带前导反引号)**,是扫描过滤标记,不是包版本号,别"修正"它。
- **lazyBackup 默认开(0.6.0)**:首写只落 base,`states/<key>/past` 由该 key 的**首次更新**创建;构造 `{lazyBackup: false}` 恢复旧的首写双写。已更新的 key 其 past 语义不变(past = 上一代)。
- 集合扫描(`Keys`/`Iterate`/`CollectionSanitize`)只认 `*.db` 结尾且不含 `index_`、`` `v `` 的文件——SafeWrite 的临时文件名不含 `.db` 后缀正是为了被扫描忽略,改动命名时必须保持该性质。
- `keys()` 的键取自**文件内容的 `_id`**,文件名只是初筛;返回值 = 磁盘扫描结果 ∪ 内存缓存。

## 关键不变量(改动必须保持)

1. **原子写**:所有落盘走 `SafeWrite`(临时文件 + fsync + rename;Windows rename 遇 EPERM/EACCES/EBUSY 指数退避重试)。绝不允许直接 truncate + write。
2. **per-key 串行**:同一 key 的写/读/删经 `operationQueue.enqueue(key, ...)` 排队;`clear()` 先 `pending()` 排空再执行。恢复路径(读时自愈)会改文件,必须与在途写互斥。
3. **恢复语义矩阵**:base 损坏/缺失 → 从 backup 复制还原;backup 也不可用 → 双删并 `untrackKey`。lazyBackup(默认开)下首写无 backup,等价于"无备份目录"分支(丢弃 + untrack);base 缺失但**备份目录存在** → 仍双写新载荷。`Exists` 例外:只判定、只清理证明损坏的 backup,从不复活。索引的"空占位符" `[{"key":null,"value":[]}]` 由 `indexCheck` 识别,存空索引时不落 base 文件。
4. **durability**:`'strict'`/`'relaxed'` 只影响 fsync;恢复写恒为 strict。
5. **错误前缀**:所有 utils 的错误信息以 `:::Storage::: <方法名> Error. ` 开头,`safe*` 系列仅在 ENOENT 时 resolve(false),其余错误必须 reject(按 `err.code` 判断,勿用 `errno`,Windows 编号不同)。

## 测试规则

- 一律用 `spec/helpers.ts` 的 `setupStorage()`(隔离临时目录);**禁止**不带 `dir` 参数构造 `ElectronStorage`——会写进真实 OS 用户目录。
- 损坏场景用 `corruptFile`/`writeRaw`/`removePath`;索引载荷用 `EMPTY_INDEX`/`nonEmptyIndex()` 常量。
- 恢复类分支加进 `spec/unit/recoveryMatrix.spec.ts`:种两代数据 → 只破坏一处 → 同时断言返回值与磁盘终态。
- AppDirectory 平台分支用 `jest.mock('os')` 工厂(mock 掉 platform,保留其余导出);`jest.spyOn(os, 'platform')` 对 `import * as os` 的命名空间不生效。
- 已接受的未覆盖分支(竞态窗口、不可达组合)列在 [docs/TESTING.md](docs/TESTING.md) 末尾,不必强行覆盖。

## 陷阱

- Windows 上对已存在文件的并发 rename 会 EPERM——依赖 SafeWrite 内建重试,别绕过它。
- 大规模套件(`spec/large`)慢,日常迭代用 `test:coverage`;提交前跑全量。
- `Keys.readAllDir` 扫描后不回填 `allKeys` 缓存(已知 backlog,OPTIMIZATION.md #3),不要顺手"修"它而不更新该文档。
- 父目录 `obsidian-language-learner` 是 Obsidian 插件仓库;本包在其 `package/` 下且是**独立 git 仓库**,提交只在本仓库内进行。

## 文档索引

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构、数据流、并发模型
- [docs/TESTING.md](docs/TESTING.md) — 测试分层、恢复语义契约、新增测试规范
- [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md) — 优化 backlog(#3/#5/#6/#7)
- [CHANGELOG.md](CHANGELOG.md) — 版本变更记录
