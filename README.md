# 稀疏整数矩阵规范化与乘法后端

本地运行的稀疏整数矩阵计算服务:TypeScript + Node.js + SQLite(`node:sqlite`,无原生编译依赖)。只提供 HTTP API 与 CLI,不含前端。

## 功能

- 以 `(行号 i, 列号 j, 整数值)` 三元组导入稀疏矩阵,显式给出行列数,空元素列表表示全零矩阵
- 导入时规范化:合并重复坐标(值相加)、移除相加为零的项、按 `(i, j)` 稳定排序
- 导出 CSR 行压缩结构:`rowPtr` 长度为 `行数+1`,空行的指针与下一行相同,末尾等于非零元素总数
- 按非零元素做矩阵乘法:只遍历有贡献的非零项,不展开稠密矩阵;中间累加使用 BigInt 精确整数
- 整数值一律以十进制字符串在 API 中传递,不经过不安全的 JavaScript Number
- 矩阵按 `名称 + 版本` 管理;乘法结果绑定两个确定的输入版本,后续更改输入不影响旧结果
- 结果元信息与非零元素在同一事务提交,失败不会留下半矩阵
- 可查询某个结果元素的逐项来源乘积(哪些 `A[i,k] * B[k,j]` 贡献而来)
- 可比较同一矩阵的两个版本差异

## 运行要求

- Windows 本地,Node.js >= 22.5(开发使用 Node 25),无需 Docker / WSL / 外部服务

## 命令

```powershell
npm install        # 安装依赖(仅 typescript 和 @types/node)
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务(默认端口 0 = 自动选择空闲端口)
npm run demo       # 运行演示:空行、重复坐标相消、负数、逐项乘加
```

CLI 直接用法(数据保存在项目内 `data/` 目录,可用环境变量 `MATRIX_DATA_DIR` 修改):

```powershell
node dist/src/cli.js serve --port 8080        # 指定端口;PORT 环境变量亦可
node dist/src/cli.js create matrix.json       # 从 JSON 文件创建矩阵
node dist/src/cli.js versions A               # 列出版本
node dist/src/cli.js entries A 1              # 查看规范化三元组
node dist/src/cli.js csr A 1                  # 查看 CSR
node dist/src/cli.js multiply A 1 B 1 C       # C = A(v1) * B(v1)
node dist/src/cli.js result C                 # 查看结果
node dist/src/cli.js element C 0 1            # 结果元素 (0,1) 的逐项来源乘积
node dist/src/cli.js compare A 1 2            # 比较版本
node dist/src/cli.js export C csr             # 导出(entries 或 csr)
```

## 输入格式

```json
{
  "name": "A",
  "rows": 3,
  "cols": 4,
  "entries": [
    { "i": 0, "j": 1, "value": "-3" },
    { "i": 2, "j": 3, "value": "7" }
  ]
}
```

- `i`、`j` 为从 0 开始的非负整数,必须在行列范围内
- `value` 为整数,推荐用十进制字符串;JSON number 仅在安全整数范围内接受
- `entries` 为空数组即全零矩阵

## CSR 行指针说明

`rowPtr[r]` 是第 `r` 行第一个非零元素在 `colIdx`/`values` 中的下标,`rowPtr[r+1] - rowPtr[r]` 是该行非零元素个数。空行满足 `rowPtr[r] == rowPtr[r+1]`;`rowPtr` 最后一项等于非零元素总数。例如 3 行矩阵只有第 2 行有 1 个元素:`rowPtr = [0, 0, 0, 1]`。

## 整数表示

所有整数值在 API 中以十进制字符串表示(如 `"9007199254740993"`),服务端用 BigInt 精确存储与累加,支持任意大小的整数,不会静默经过 IEEE 754 双精度。直接传 JSON number 时,非整数报 `NOT_INTEGER`,超出安全整数范围报 `UNSAFE_INTEGER`。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/matrices` | 创建矩阵 `{name, rows, cols, entries, version?}` |
| GET | `/matrices/:name` | 列出版本 |
| GET | `/matrices/:name/:version/entries?limit&offset` | 规范化三元组 |
| GET | `/matrices/:name/:version/csr` | CSR 结构 |
| GET | `/matrices/:name/compare?v1=&v2=` | 比较版本 |
| POST | `/multiply` | `{a:{name,version}, b:{name,version}, resultName}` |
| GET | `/results/:name?limit&offset` | 结果元信息与三元组 |
| GET | `/results/:name/csr` | 结果 CSR |
| GET | `/results/:name/element?i=&j=` | 逐项来源乘积 |
| GET | `/results/:name/export?format=entries\|csr` | 导出 |

错误统一返回 `{"error": {"code": "...", "message": "..."}}`,错误码包括:
`NOT_INTEGER`、`UNSAFE_INTEGER`、`BAD_DIMENSION`、`OUT_OF_BOUNDS`、`LIMIT_EXCEEDED`、`DIMENSION_MISMATCH`、`VERSION_EXISTS`、`RESULT_EXISTS`、`NOT_FOUND`、`BAD_JSON`、`BAD_PARAM`。

## 规模上限与限制

- 维度上限 10000,单矩阵非零元素上限 100000(超出报 `LIMIT_EXCEEDED`)
- 查询结果默认返回 1000 条,最大 10000 条,用 `limit`/`offset` 分页
- 仅面向中小型矩阵:不实现稀疏分解、特征值、浮点求解或并行计算
- `node:sqlite` 在 Node 25 仍标记为 experimental,启动时会有一条警告,不影响功能
