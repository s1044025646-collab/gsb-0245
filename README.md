# 稀疏整数矩阵规范化与乘法服务

一个 Windows 本地可运行的稀疏整数矩阵后端：TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生依赖、无 Docker、无外部服务）。只提供 HTTP API 与 CLI，无前端。

## 功能

- 以「行号、列号、整数值」三元组导入稀疏矩阵，显式给出行列数，空元素列表表示全零矩阵
- 导入时规范化：合并重复坐标（值相加）、移除相加为零的项、按 `(row, col)` 稳定排序
- 自行实现按非零项遍历的稀疏乘法（不展开稠密矩阵），中间累加使用 BigInt 精确整数
- 矩阵按「名称 + 版本」管理，版本不可变；乘积结果绑定两个确定输入版本，永久可查询
- 导出三元组与 CSR 行压缩结构；可查询某个结果元素的逐项来源乘积
- 元信息与非零元素在同一事务提交，失败不留下半矩阵、半结果

## 运行环境

- Node.js ≥ 22.5（使用内置 `node:sqlite`，会有 ExperimentalWarning，可忽略）
- Windows 本地运行，无需 Docker / WSL / 网络服务

## 构建、测试、启动、演示

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # 编译 TypeScript 到 dist/
npm test           # 编译并运行全部测试（含独立稠密参照实现对照）
npm start          # 启动 HTTP API，默认端口 0 = 自动选择空闲端口
npm run cli -- serve --port 8080   # 指定端口
npm run demo       # 运行演示：规范化、CSR、逐项乘加解释
```

数据保存在项目内 `data/` 目录（`matrices.db`，演示用 `demo.db`）。

## 输入格式

```json
{
  "name": "A",
  "version": "v1",
  "rows": 3,
  "cols": 3,
  "elements": [
    { "row": 0, "col": 0, "value": "2" },
    { "row": 0, "col": 1, "value": "4" },
    { "row": 0, "col": 1, "value": "-4" },
    { "row": 1, "col": 1, "value": "-3" }
  ]
}
```

- `row`/`col` 为 0 起始的整数下标，越界（`>= rows/cols` 或 `< 0`）会被拒绝
- `value` 用**十进制字符串**传值（也接受安全整数 number）。内部全程 BigInt，支持超出 `Number.MAX_SAFE_INTEGER` 的合法值，例如 `"9007199254740993"`，不会静默丢失精度
- 上例中 `(0,1)` 的 `4 + (-4) = 0`，规范化后该项消失

## CSR 行压缩结构

```json
{ "rows": 3, "cols": 3, "rowPtr": [0, 1, 3, 3], "colIdx": [0, 1, 2], "values": ["2", "-3", "5"] }
```

- `rowPtr` 长度为 `rows + 1`；第 `i` 行的非零元是 `colIdx[rowPtr[i] .. rowPtr[i+1])`
- 空行：`rowPtr[i] == rowPtr[i+1]`（上例第 2 行为空，`rowPtr[2] == rowPtr[3] == 3`）
- 末尾位置：`rowPtr[rows]` 恒等于非零元素总数

## 稀疏乘法

若 A 的列数等于 B 的行数，`C[i,j] = Σ_k A[i,k] * B[k,j]`。实现只遍历有贡献的非零项：对 A 的每个非零元 `(i,k)`，查 B 第 `k` 行的非零元 `(k,j)` 累加乘积，全程 BigInt。结果中累加为零的项不存储。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/matrices` | 创建矩阵（body 见输入格式），返回规范化结果 |
| GET | `/matrices` | 列出所有矩阵版本 |
| GET | `/matrices/:name/:version?limit=&offset=` | 查看规范化三元组 |
| GET | `/matrices/:name/:version/csr` | 查看 CSR |
| GET | `/matrices/:name/:version/export?format=triples\|csr` | 导出 |
| GET | `/matrices/:name/compare?from=v1&to=v2` | 比较两个版本（新增/删除/变更） |
| POST | `/multiply` | body: `{"a":{"name","version"},"b":{"name","version"}}`，返回 productId |
| GET | `/products/:id?limit=&offset=` | 查看乘积三元组 |
| GET | `/products/:id/csr` | 乘积 CSR |
| GET | `/products/:id/element?i=&j=` | 查看 C[i,j] 的逐项来源乘积 |
| GET | `/products/:id/export?format=triples\|csr` | 导出乘积 |
| GET | `/health` | 健康检查 |

错误统一返回 `{"error":{"code","message"}}`，错误码：`INVALID_DIMENSION`、`OUT_OF_BOUNDS`、`NON_INTEGER`、`LIMIT_EXCEEDED`、`DIM_MISMATCH`、`NOT_FOUND`、`DUPLICATE_VERSION`、`BAD_REQUEST`。

公开规模上限：行列数 ≤ 10000，单矩阵/乘积非零元 ≤ 100000，单次查询返回条数默认 1000、最大 10000（`limit` 参数），请求体 ≤ 10MB。

## CLI

```powershell
npm run cli -- create matrix.json          # 从 JSON 文件创建矩阵
npm run cli -- list                        # 列出所有矩阵版本
npm run cli -- show A v1 --limit 100       # 查看三元组
npm run cli -- csr A v1                    # 查看 CSR
npm run cli -- compare A v1 v2             # 比较版本
npm run cli -- export A v1 csr             # 导出
npm run cli -- multiply A v1 B v1          # 乘法，输出 productId
npm run cli -- product 1                   # 查看乘积
npm run cli -- product-csr 1               # 乘积 CSR
npm run cli -- element 1 0 0               # C[0,0] 逐项来源
npm run cli -- product-export 1 triples    # 导出乘积
npm run cli -- serve --port 0              # 启动 API（0 = 自动空闲端口）
```

## 项目结构

- `src/matrix.ts` — 规范化、CSR、稀疏乘法、元素来源解释（纯函数）
- `src/db.ts` — SQLite 表结构与事务化写入
- `src/service.ts` — 业务逻辑（API 与 CLI 共用）
- `src/api.ts` — HTTP 服务器（Node 内置 http）
- `src/cli.ts` — 命令行入口
- `test/matrix.test.ts` — 测试（含独立稠密参照实现）
- `scripts/demo.ts` — 演示脚本

## 范围与限制

- 只做中小型稀疏整数矩阵；不做浮点、稠密展开、稀疏分解、特征值、并行计算
- `node:sqlite` 在 Node 25 仍标记为实验性，但功能稳定可用
- 单机本地服务，无鉴权，监听 `127.0.0.1`
