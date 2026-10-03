import { ApiError } from "./errors";

export const MAX_DIM = 10000;
export const MAX_NNZ = 100000;
export const DEFAULT_RESULT_LIMIT = 1000;
export const MAX_RESULT_LIMIT = 10000;

export interface Triple {
  row: number;
  col: number;
  value: bigint;
}

export interface Csr {
  rows: number;
  cols: number;
  rowPtr: number[];
  colIdx: number[];
  values: string[];
}

export function parseBigIntValue(v: unknown, field = "value"): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) {
      throw new ApiError(
        "NON_INTEGER",
        `${field} 不是安全整数，请用十进制字符串传值`
      );
    }
    return BigInt(v);
  }
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
    return BigInt(v.trim());
  }
  throw new ApiError(
    "NON_INTEGER",
    `${field} 必须是整数或整数字符串，收到: ${JSON.stringify(v)}`
  );
}

export function parseIndex(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ApiError("NON_INTEGER", `${field} 必须是整数`);
  }
  return v;
}

export function validateDims(rows: unknown, cols: unknown): { rows: number; cols: number } {
  const r = parseIndex(rows, "rows");
  const c = parseIndex(cols, "cols");
  if (r < 0 || c < 0 || r > MAX_DIM || c > MAX_DIM) {
    throw new ApiError(
      "INVALID_DIMENSION",
      `行列数必须在 [0, ${MAX_DIM}] 内，收到 ${r}x${c}`
    );
  }
  return { rows: r, cols: c };
}

/**
 * 规范化三元组列表：校验坐标、合并重复坐标（值相加）、
 * 移除相加为零的项，并按 (row, col) 稳定排序。
 */
export function normalize(
  rows: number,
  cols: number,
  elements: { row: number; col: number; value: bigint }[]
): Triple[] {
  if (elements.length > MAX_NNZ) {
    throw new ApiError(
      "LIMIT_EXCEEDED",
      `非零元素数量 ${elements.length} 超过上限 ${MAX_NNZ}`
    );
  }
  const acc = new Map<string, bigint>();
  for (const e of elements) {
    if (!Number.isInteger(e.row) || !Number.isInteger(e.col)) {
      throw new ApiError("NON_INTEGER", "坐标必须是整数");
    }
    if (e.row < 0 || e.row >= rows || e.col < 0 || e.col >= cols) {
      throw new ApiError(
        "OUT_OF_BOUNDS",
        `坐标 (${e.row}, ${e.col}) 超出矩阵范围 ${rows}x${cols}`
      );
    }
    const key = `${e.row},${e.col}`;
    acc.set(key, (acc.get(key) ?? 0n) + e.value);
  }
  const out: Triple[] = [];
  for (const [key, value] of acc) {
    if (value === 0n) continue;
    const [r, c] = key.split(",");
    out.push({ row: Number(r), col: Number(c), value });
  }
  out.sort((a, b) => a.row - b.row || a.col - b.col);
  return out;
}

/** 由已排序三元组构造 CSR。rowPtr 长度为 rows+1，空行指针与下一行相同，末位等于非零总数。 */
export function toCsr(rows: number, cols: number, triples: Triple[]): Csr {
  const rowPtr = new Array<number>(rows + 1).fill(0);
  const colIdx: number[] = [];
  const values: string[] = [];
  let cur = 0;
  for (let i = 0; i < triples.length; i++) {
    const t = triples[i];
    while (cur <= t.row) {
      rowPtr[cur] = i;
      cur++;
    }
    colIdx.push(t.col);
    values.push(t.value.toString());
  }
  while (cur <= rows) {
    rowPtr[cur] = triples.length;
    cur++;
  }
  return { rows, cols, rowPtr, colIdx, values };
}

/**
 * 稀疏乘法：只遍历有贡献的非零项。
 * 对 A 的每个非零元 (i,k)，查 B 的第 k 行非零元 (k,j)，累加 A[i,k]*B[k,j]。
 * 中间累加使用 BigInt，保证精确。
 */
export function multiply(
  aRows: number,
  aCols: number,
  a: Triple[],
  bRows: number,
  bCols: number,
  b: Triple[]
): Triple[] {
  if (aCols !== bRows) {
    throw new ApiError(
      "DIM_MISMATCH",
      `维度不匹配：A 列数 ${aCols} != B 行数 ${bRows}`
    );
  }
  // B 按行分组
  const bByRow = new Map<number, Triple[]>();
  for (const t of b) {
    let arr = bByRow.get(t.row);
    if (!arr) bByRow.set(t.row, (arr = []));
    arr.push(t);
  }
  const acc = new Map<string, bigint>();
  for (const ta of a) {
    const brow = bByRow.get(ta.col);
    if (!brow) continue;
    for (const tb of brow) {
      const key = `${ta.row},${tb.col}`;
      acc.set(key, (acc.get(key) ?? 0n) + ta.value * tb.value);
    }
  }
  const out: Triple[] = [];
  for (const [key, value] of acc) {
    if (value === 0n) continue;
    const [r, c] = key.split(",");
    out.push({ row: Number(r), col: Number(c), value });
  }
  out.sort((x, y) => x.row - y.row || x.col - y.col);
  if (out.length > MAX_NNZ) {
    throw new ApiError(
      "LIMIT_EXCEEDED",
      `乘积非零元素数量 ${out.length} 超过上限 ${MAX_NNZ}`
    );
  }
  return out;
}

export interface Contribution {
  k: number;
  aValue: string;
  bValue: string;
  product: string;
}

/** 解释 C[i,j] 的来源：列出所有 k 使 A[i,k]*B[k,j] != 0。 */
export function explainElement(
  i: number,
  j: number,
  a: Triple[],
  b: Triple[]
): { value: bigint; contributions: Contribution[] } {
  const bByRow = new Map<number, Triple[]>();
  for (const t of b) {
    let arr = bByRow.get(t.row);
    if (!arr) bByRow.set(t.row, (arr = []));
    arr.push(t);
  }
  const contributions: Contribution[] = [];
  let total = 0n;
  for (const ta of a) {
    if (ta.row !== i) continue;
    const brow = bByRow.get(ta.col);
    if (!brow) continue;
    for (const tb of brow) {
      if (tb.col !== j) continue;
      const p = ta.value * tb.value;
      total += p;
      contributions.push({
        k: ta.col,
        aValue: ta.value.toString(),
        bValue: tb.value.toString(),
        product: p.toString(),
      });
    }
  }
  contributions.sort((x, y) => x.k - y.k);
  return { value: total, contributions };
}
