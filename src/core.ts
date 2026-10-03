export interface EntryInput { i: number; j: number; value: string | number | bigint; }
export interface Entry { i: number; j: number; value: bigint; }

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export const LIMITS = {
  MAX_DIM: 10000,
  MAX_NNZ: 100000,
  DEFAULT_RESULT_LIMIT: 1000,
  MAX_RESULT_LIMIT: 10000,
};

export function parseInteger(v: string | number | bigint, field: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new ApiError("NOT_INTEGER", `${field} 不是整数: ${v}`);
    if (!Number.isSafeInteger(v))
      throw new ApiError("UNSAFE_INTEGER", `${field} 超出安全整数范围,请用十进制字符串传值: ${v}`);
    return BigInt(v);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^[+-]?\d+$/.test(s)) throw new ApiError("NOT_INTEGER", `${field} 不是整数十进制字符串: ${v}`);
    return BigInt(s);
  }
  throw new ApiError("NOT_INTEGER", `${field} 类型不支持`);
}

export function parseDim(v: unknown, field: string): number {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
    throw new ApiError("BAD_DIMENSION", `${field} 必须是非负整数`);
  if (n > LIMITS.MAX_DIM) throw new ApiError("LIMIT_EXCEEDED", `${field} 超过上限 ${LIMITS.MAX_DIM}`);
  return n;
}

/** 规范化:合并重复坐标、移除相加为零的项、按 (i,j) 稳定排序 */
export function normalizeEntries(raw: EntryInput[], rows: number, cols: number): Entry[] {
  if (!Array.isArray(raw)) throw new ApiError("BAD_ENTRIES", "entries 必须是数组");
  if (raw.length > LIMITS.MAX_NNZ)
    throw new ApiError("LIMIT_EXCEEDED", `非零元素数量超过上限 ${LIMITS.MAX_NNZ}`);
  const acc = new Map<string, bigint>();
  for (const e of raw) {
    if (e == null || typeof e !== "object") throw new ApiError("BAD_ENTRIES", "元素必须是 {i,j,value}");
    const i = parseDim(e.i, "行号 i");
    const j = parseDim(e.j, "列号 j");
    if (i >= rows) throw new ApiError("OUT_OF_BOUNDS", `行号 ${i} 越界(行数 ${rows})`);
    if (j >= cols) throw new ApiError("OUT_OF_BOUNDS", `列号 ${j} 越界(列数 ${cols})`);
    const v = parseInteger(e.value, `元素(${i},${j})的值`);
    const key = i + "," + j;
    acc.set(key, (acc.get(key) ?? 0n) + v);
  }
  const out: Entry[] = [];
  for (const [key, value] of acc) {
    if (value === 0n) continue; // 相加为零的项被移除
    const [i, j] = key.split(",").map(Number);
    out.push({ i, j, value });
  }
  if (out.length > LIMITS.MAX_NNZ)
    throw new ApiError("LIMIT_EXCEEDED", `规范化后非零元素数量超过上限 ${LIMITS.MAX_NNZ}`);
  out.sort((a, b) => (a.i - b.i) || (a.j - b.j));
  return out;
}

/** CSR:rowPtr 长度 rows+1,空行指针与下一行相同,末尾为 nnz */
export function toCsr(entries: Entry[], rows: number) {
  const rowPtr: number[] = new Array(rows + 1).fill(0);
  for (const e of entries) rowPtr[e.i + 1]++;
  for (let r = 0; r < rows; r++) rowPtr[r + 1] += rowPtr[r];
  return {
    rowPtr,
    colIdx: entries.map((e) => e.j),
    values: entries.map((e) => e.value.toString(10)),
    nnz: entries.length,
  };
}

/** 按非零元素做乘法:A(m×k) * B(k×n),只遍历有贡献的非零项,BigInt 精确累加 */
export function multiplyEntries(a: Entry[], b: Entry[], aCols: number, bRows: number): Entry[] {
  if (aCols !== bRows)
    throw new ApiError("DIMENSION_MISMATCH", `A 的列数(${aCols})不等于 B 的行数(${bRows})`);
  const bByRow = new Map<number, Entry[]>();
  for (const e of b) {
    let arr = bByRow.get(e.i);
    if (!arr) bByRow.set(e.i, (arr = []));
    arr.push(e);
  }
  const acc = new Map<string, bigint>();
  for (const ea of a) {
    const brow = bByRow.get(ea.j);
    if (!brow) continue;
    for (const eb of brow) {
      const key = ea.i + "," + eb.j;
      acc.set(key, (acc.get(key) ?? 0n) + ea.value * eb.value);
    }
  }
  const out: Entry[] = [];
  for (const [key, value] of acc) {
    if (value === 0n) continue;
    const [i, j] = key.split(",").map(Number);
    out.push({ i, j, value });
  }
  out.sort((x, y) => (x.i - y.i) || (x.j - y.j));
  return out;
}

/** 单个结果元素的逐项来源乘积 */
export function elementProvenance(a: Entry[], b: Entry[], i: number, j: number) {
  const bByRow = new Map<number, Entry[]>();
  for (const e of b) {
    let arr = bByRow.get(e.i);
    if (!arr) bByRow.set(e.i, (arr = []));
    arr.push(e);
  }
  const terms: { k: number; a: string; b: string; product: string }[] = [];
  let sum = 0n;
  for (const ea of a) {
    if (ea.i !== i) continue;
    const brow = bByRow.get(ea.j);
    if (!brow) continue;
    for (const eb of brow) {
      if (eb.j !== j) continue;
      const product = ea.value * eb.value;
      sum += product;
      terms.push({ k: ea.j, a: ea.value.toString(10), b: eb.value.toString(10), product: product.toString(10) });
    }
  }
  return { i, j, value: sum.toString(10), terms };
}
