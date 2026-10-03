import { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors";
import * as db from "./db";
import * as M from "./matrix";

function clampLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return M.DEFAULT_RESULT_LIMIT;
  const n = M.parseIndex(limit, "limit");
  if (n <= 0 || n > M.MAX_RESULT_LIMIT) {
    throw new ApiError(
      "LIMIT_EXCEEDED",
      `limit 必须在 1..${M.MAX_RESULT_LIMIT} 之间`
    );
  }
  return n;
}

export function createMatrix(d: DatabaseSync, body: any) {
  if (!body || typeof body !== "object") {
    throw new ApiError("BAD_REQUEST", "请求体必须是 JSON 对象");
  }
  const { name, version } = body;
  if (typeof name !== "string" || !name) {
    throw new ApiError("BAD_REQUEST", "name 必须是非空字符串");
  }
  if (typeof version !== "string" || !version) {
    throw new ApiError("BAD_REQUEST", "version 必须是非空字符串");
  }
  const { rows, cols } = M.validateDims(body.rows, body.cols);
  const raw = body.elements ?? [];
  if (!Array.isArray(raw)) {
    throw new ApiError("BAD_REQUEST", "elements 必须是数组");
  }
  const parsed = raw.map((e: any, i: number) => ({
    row: M.parseIndex(e?.row, `elements[${i}].row`),
    col: M.parseIndex(e?.col, `elements[${i}].col`),
    value: M.parseBigIntValue(e?.value, `elements[${i}].value`),
  }));
  const triples = M.normalize(rows, cols, parsed);
  const id = db.insertMatrix(d, name, version, rows, cols, triples);
  return {
    id,
    name,
    version,
    rows,
    cols,
    nnz: triples.length,
    elements: triples.map((t) => ({ ...t, value: t.value.toString() })),
  };
}

export function getElements(d: DatabaseSync, name: string, version: string, limit?: unknown, offset?: unknown) {
  const m = db.getMatrix(d, name, version);
  const all = db.loadTriples(d, m.id);
  const lim = clampLimit(limit);
  const off = offset === undefined ? 0 : M.parseIndex(offset, "offset");
  const slice = all.slice(off, off + lim);
  return {
    ...m,
    nnz: all.length,
    returned: slice.length,
    offset: off,
    limit: lim,
    elements: slice.map((t) => ({ ...t, value: t.value.toString() })),
  };
}

export function getCsr(d: DatabaseSync, name: string, version: string) {
  const m = db.getMatrix(d, name, version);
  return M.toCsr(m.rows, m.cols, db.loadTriples(d, m.id));
}

export function multiplyMatrices(d: DatabaseSync, body: any) {
  const aRef = body?.a;
  const bRef = body?.b;
  if (!aRef?.name || !aRef?.version || !bRef?.name || !bRef?.version) {
    throw new ApiError("BAD_REQUEST", "需要 a:{name,version} 与 b:{name,version}");
  }
  const a = db.getMatrix(d, aRef.name, aRef.version);
  const b = db.getMatrix(d, bRef.name, bRef.version);
  const aT = db.loadTriples(d, a.id);
  const bT = db.loadTriples(d, b.id);
  const c = M.multiply(a.rows, a.cols, aT, b.rows, b.cols, bT);
  const id = db.insertProduct(d, a.id, b.id, a.rows, b.cols, c);
  return {
    id,
    a: { name: a.name, version: a.version },
    b: { name: b.name, version: b.version },
    rows: a.rows,
    cols: b.cols,
    nnz: c.length,
  };
}

export function getProductElements(d: DatabaseSync, id: number, limit?: unknown, offset?: unknown) {
  const p = db.getProduct(d, id);
  const a = db.getMatrixById(d, p.a_matrix_id);
  const b = db.getMatrixById(d, p.b_matrix_id);
  const all = db.loadProductTriples(d, id);
  const lim = clampLimit(limit);
  const off = offset === undefined ? 0 : M.parseIndex(offset, "offset");
  const slice = all.slice(off, off + lim);
  return {
    id,
    a: { name: a.name, version: a.version },
    b: { name: b.name, version: b.version },
    rows: p.rows,
    cols: p.cols,
    nnz: all.length,
    returned: slice.length,
    elements: slice.map((t) => ({ ...t, value: t.value.toString() })),
  };
}

export function getProductCsr(d: DatabaseSync, id: number) {
  const p = db.getProduct(d, id);
  return M.toCsr(p.rows, p.cols, db.loadProductTriples(d, id));
}

export function explainProductElement(d: DatabaseSync, id: number, i: unknown, j: unknown) {
  const p = db.getProduct(d, id);
  const row = M.parseIndex(i, "i");
  const col = M.parseIndex(j, "j");
  if (row < 0 || row >= p.rows || col < 0 || col >= p.cols) {
    throw new ApiError("OUT_OF_BOUNDS", `(${row}, ${col}) 超出乘积范围 ${p.rows}x${p.cols}`);
  }
  const aT = db.loadTriples(d, p.a_matrix_id);
  const bT = db.loadTriples(d, p.b_matrix_id);
  const { value, contributions } = M.explainElement(row, col, aT, bT);
  return { row, col, value: value.toString(), contributions };
}

export function compareVersions(d: DatabaseSync, name: string, v1: string, v2: string) {
  const m1 = db.getMatrix(d, name, v1);
  const m2 = db.getMatrix(d, name, v2);
  if (m1.rows !== m2.rows || m1.cols !== m2.cols) {
    return {
      name,
      versions: [v1, v2],
      dimsChanged: { from: [m1.rows, m1.cols], to: [m2.rows, m2.cols] },
    };
  }
  const t1 = db.loadTriples(d, m1.id);
  const t2 = db.loadTriples(d, m2.id);
  const map1 = new Map(t1.map((t) => [`${t.row},${t.col}`, t.value]));
  const map2 = new Map(t2.map((t) => [`${t.row},${t.col}`, t.value]));
  const added: any[] = [];
  const removed: any[] = [];
  const changed: any[] = [];
  for (const [k, v] of map2) {
    const [row, col] = k.split(",").map(Number);
    if (!map1.has(k)) added.push({ row, col, value: v.toString() });
    else if (map1.get(k) !== v)
      changed.push({ row, col, from: map1.get(k)!.toString(), to: v.toString() });
  }
  for (const [k, v] of map1) {
    if (!map2.has(k)) {
      const [row, col] = k.split(",").map(Number);
      removed.push({ row, col, value: v.toString() });
    }
  }
  return { name, versions: [v1, v2], nnz: [t1.length, t2.length], added, removed, changed };
}

export function exportMatrix(d: DatabaseSync, name: string, version: string, format: string) {
  const m = db.getMatrix(d, name, version);
  const triples = db.loadTriples(d, m.id);
  if (format === "csr") return { format, ...M.toCsr(m.rows, m.cols, triples) };
  if (format === "triples")
    return {
      format,
      rows: m.rows,
      cols: m.cols,
      elements: triples.map((t) => ({ ...t, value: t.value.toString() })),
    };
  throw new ApiError("BAD_REQUEST", `未知导出格式 "${format}"，支持 triples | csr`);
}

export function exportProduct(d: DatabaseSync, id: number, format: string) {
  const p = db.getProduct(d, id);
  const triples = db.loadProductTriples(d, id);
  if (format === "csr") return { format, ...M.toCsr(p.rows, p.cols, triples) };
  if (format === "triples")
    return {
      format,
      rows: p.rows,
      cols: p.cols,
      elements: triples.map((t) => ({ ...t, value: t.value.toString() })),
    };
  throw new ApiError("BAD_REQUEST", `未知导出格式 "${format}"，支持 triples | csr`);
}

export function listMatrices(d: DatabaseSync) {
  return d
    .prepare(
      `SELECT m.id, m.name, m.version, m.rows, m.cols, m.created_at,
              (SELECT COUNT(*) FROM elements e WHERE e.matrix_id = m.id) AS nnz
       FROM matrices m ORDER BY m.name, m.version`
    )
    .all();
}
