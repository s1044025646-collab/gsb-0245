import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openDb } from "../src/db";
import * as svc from "../src/service";
import { ApiError } from "../src/errors";
import { Triple } from "../src/matrix";

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparse-test-"));
  return openDb(path.join(dir, "test.db"));
}

/** 独立稠密参照实现 */
function denseMultiply(
  aRows: number, aCols: number, a: Triple[],
  bRows: number, bCols: number, b: Triple[]
): Map<string, bigint> {
  const A: bigint[][] = Array.from({ length: aRows }, () => new Array(aCols).fill(0n));
  const B: bigint[][] = Array.from({ length: bRows }, () => new Array(bCols).fill(0n));
  for (const t of a) A[t.row][t.col] += t.value;
  for (const t of b) B[t.row][t.col] += t.value;
  const out = new Map<string, bigint>();
  for (let i = 0; i < aRows; i++)
    for (let j = 0; j < bCols; j++) {
      let s = 0n;
      for (let k = 0; k < aCols; k++) s += A[i][k] * B[k][j];
      if (s !== 0n) out.set(`${i},${j}`, s);
    }
  return out;
}

function toMap(triples: { row: number; col: number; value: string }[]) {
  return new Map(triples.map((t) => [`${t.row},${t.col}`, BigInt(t.value)]));
}

function create(db: any, name: string, version: string, rows: number, cols: number, elements: any[]) {
  return svc.createMatrix(db, { name, version, rows, cols, elements });
}

test("规范化：合并重复坐标、相消为零、按行列排序", () => {
  const db = freshDb();
  const m = create(db, "A", "v1", 3, 3, [
    { row: 2, col: 0, value: "5" },
    { row: 0, col: 1, value: "3" },
    { row: 0, col: 1, value: "-3" }, // 与上一项相消
    { row: 2, col: 0, value: "7" },  // 合并为 12
    { row: 1, col: 2, value: "-4" },
  ]);
  assert.equal(m.nnz, 2);
  assert.deepEqual(m.elements, [
    { row: 1, col: 2, value: "-4" },
    { row: 2, col: 0, value: "12" },
  ]);
});

test("CSR：空行指针与末尾位置正确", () => {
  const db = freshDb();
  create(db, "C", "v1", 4, 3, [
    { row: 0, col: 0, value: "1" },
    { row: 0, col: 2, value: "2" },
    { row: 3, col: 1, value: "9" },
  ]);
  const csr = svc.getCsr(db, "C", "v1");
  assert.deepEqual(csr.rowPtr, [0, 2, 2, 2, 3]);
  assert.deepEqual(csr.colIdx, [0, 2, 1]);
  assert.deepEqual(csr.values, ["1", "2", "9"]);
});

test("零矩阵：空元素列表", () => {
  const db = freshDb();
  const m = create(db, "Z", "v1", 3, 3, []);
  assert.equal(m.nnz, 0);
  const csr = svc.getCsr(db, "Z", "v1");
  assert.deepEqual(csr.rowPtr, [0, 0, 0, 0]);
});

test("乘法：单位矩阵与矩形维度，对照稠密参照", () => {
  const db = freshDb();
  // 3x2 矩阵
  const aElems = [
    { row: 0, col: 0, value: "1" },
    { row: 0, col: 1, value: "2" },
    { row: 1, col: 0, value: "3" },
    { row: 2, col: 1, value: "-5" },
  ];
  // 2x4 矩阵
  const bElems = [
    { row: 0, col: 0, value: "7" },
    { row: 0, col: 3, value: "1" },
    { row: 1, col: 1, value: "2" },
    { row: 1, col: 3, value: "-1" },
  ];
  create(db, "A", "v1", 3, 2, aElems);
  create(db, "B", "v1", 2, 4, bElems);
  const p = svc.multiplyMatrices(db, { a: { name: "A", version: "v1" }, b: { name: "B", version: "v1" } });
  const got = svc.getProductElements(db, p.id);
  const expect = denseMultiply(3, 2, aElems.map(e => ({...e, value: BigInt(e.value)})),
                                 2, 4, bElems.map(e => ({...e, value: BigInt(e.value)})));
  assert.deepEqual(toMap(got.elements), expect);

  // 单位矩阵：I * B = B
  create(db, "I", "v1", 2, 2, [
    { row: 0, col: 0, value: "1" },
    { row: 1, col: 1, value: "1" },
  ]);
  const p2 = svc.multiplyMatrices(db, { a: { name: "I", version: "v1" }, b: { name: "B", version: "v1" } });
  const got2 = svc.getProductElements(db, p2.id);
  assert.deepEqual(toMap(got2.elements), toMap(svc.getElements(db, "B", "v1").elements));
});

test("乘法：多个贡献相消后该项消失", () => {
  const db = freshDb();
  create(db, "A", "v1", 1, 2, [
    { row: 0, col: 0, value: "1" },
    { row: 0, col: 1, value: "1" },
  ]);
  create(db, "B", "v1", 2, 1, [
    { row: 0, col: 0, value: "5" },
    { row: 1, col: 0, value: "-5" },
  ]);
  const p = svc.multiplyMatrices(db, { a: { name: "A", version: "v1" }, b: { name: "B", version: "v1" } });
  assert.equal(p.nnz, 0);
  const ex = svc.explainProductElement(db, p.id, 0, 0);
  assert.equal(ex.value, "0");
  assert.equal(ex.contributions.length, 2);
});

test("大整数：超出安全整数范围的合法值精确计算", () => {
  const db = freshDb();
  const big = "9007199254740993"; // 2^53 + 1
  create(db, "A", "v1", 1, 1, [{ row: 0, col: 0, value: big }]);
  create(db, "B", "v1", 1, 1, [{ row: 0, col: 0, value: big }]);
  const p = svc.multiplyMatrices(db, { a: { name: "A", version: "v1" }, b: { name: "B", version: "v1" } });
  const got = svc.getProductElements(db, p.id);
  assert.equal(got.elements[0].value, (BigInt(big) * BigInt(big)).toString());
});

test("element 解释：逐项乘加来源", () => {
  const db = freshDb();
  create(db, "A", "v1", 2, 2, [
    { row: 0, col: 0, value: "2" },
    { row: 0, col: 1, value: "3" },
  ]);
  create(db, "B", "v1", 2, 2, [
    { row: 0, col: 0, value: "5" },
    { row: 1, col: 0, value: "7" },
  ]);
  const p = svc.multiplyMatrices(db, { a: { name: "A", version: "v1" }, b: { name: "B", version: "v1" } });
  const ex = svc.explainProductElement(db, p.id, 0, 0);
  assert.equal(ex.value, "31");
  assert.deepEqual(ex.contributions, [
    { k: 0, aValue: "2", bValue: "5", product: "10" },
    { k: 1, aValue: "3", bValue: "7", product: "21" },
  ]);
});

test("错误：维度不匹配、越界、非整数、超限", () => {
  const db = freshDb();
  create(db, "A", "v1", 2, 3, []);
  create(db, "B", "v1", 2, 2, []);
  assert.throws(() => svc.multiplyMatrices(db, { a: { name: "A", version: "v1" }, b: { name: "B", version: "v1" } }),
    (e: ApiError) => e.code === "DIM_MISMATCH");
  assert.throws(() => create(db, "C", "v1", 2, 2, [{ row: 2, col: 0, value: "1" }]),
    (e: ApiError) => e.code === "OUT_OF_BOUNDS");
  assert.throws(() => create(db, "C", "v1", 2, 2, [{ row: 0, col: 0, value: "1.5" }]),
    (e: ApiError) => e.code === "NON_INTEGER");
  assert.throws(() => svc.createMatrix(db, { name: "D", version: "v1", rows: 100001, cols: 1, elements: [] }),
    (e: ApiError) => e.code === "INVALID_DIMENSION");
  assert.throws(() => svc.getElements(db, "A", "v1", 99999),
    (e: ApiError) => e.code === "LIMIT_EXCEEDED");
  // 重复版本不可变
  assert.throws(() => create(db, "A", "v1", 2, 3, []),
    (e: ApiError) => e.code === "DUPLICATE_VERSION");
});

test("重启后查询：结果绑定输入版本，数据持久", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparse-test-"));
  const dbPath = path.join(dir, "test.db");
  let db = openDb(dbPath);
  create(db, "A", "v1", 1, 1, [{ row: 0, col: 0, value: "6" }]);
  create(db, "B", "v1", 1, 1, [{ row: 0, col: 0, value: "7" }]);
  const p = svc.multiplyMatrices(db, { a: { name: "A", version: "v1" }, b: { name: "B", version: "v1" } });
  db.close();
  // 模拟重启
  db = openDb(dbPath);
  const got = svc.getProductElements(db, p.id);
  assert.equal(got.elements[0].value, "42");
  // 新增 A 的新版本不影响旧结果
  create(db, "A", "v2", 1, 1, [{ row: 0, col: 0, value: "100" }]);
  const got2 = svc.getProductElements(db, p.id);
  assert.equal(got2.elements[0].value, "42");
  db.close();
});

test("结果不重复且顺序稳定", () => {
  const db = freshDb();
  create(db, "A", "v1", 3, 3, [
    { row: 0, col: 0, value: "1" }, { row: 0, col: 2, value: "2" },
    { row: 1, col: 1, value: "1" }, { row: 2, col: 0, value: "3" },
  ]);
  create(db, "B", "v1", 3, 3, [
    { row: 0, col: 0, value: "1" }, { row: 0, col: 1, value: "1" },
    { row: 1, col: 2, value: "4" }, { row: 2, col: 0, value: "5" },
  ]);
  const p = svc.multiplyMatrices(db, { a: { name: "A", version: "v1" }, b: { name: "B", version: "v1" } });
  const els = svc.getProductElements(db, p.id).elements;
  const keys = els.map((e) => `${e.row},${e.col}`);
  assert.equal(new Set(keys).size, keys.length, "无重复坐标");
  const sorted = [...els].sort((x, y) => x.row - y.row || x.col - y.col);
  assert.deepEqual(els, sorted, "按 (row,col) 稳定排序");
});

test("版本比较", () => {
  const db = freshDb();
  create(db, "A", "v1", 2, 2, [{ row: 0, col: 0, value: "1" }]);
  create(db, "A", "v2", 2, 2, [
    { row: 0, col: 0, value: "2" },
    { row: 1, col: 1, value: "9" },
  ]);
  const diff: any = svc.compareVersions(db, "A", "v1", "v2");
  assert.equal(diff.added.length, 1);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.removed.length, 0);
});
