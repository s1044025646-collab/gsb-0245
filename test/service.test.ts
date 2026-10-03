import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { MatrixService } from "../src/service";
import { ApiError } from "../src/core";

let dir: string;
let svc: MatrixService;

// 独立稠密参照实现
function denseMultiply(a: bigint[][], b: bigint[][]): bigint[][] {
  const m = a.length, k = b.length, n = b[0].length;
  const c: bigint[][] = Array.from({ length: m }, () => new Array(n).fill(0n));
  for (let i = 0; i < m; i++)
    for (let j = 0; j < n; j++)
      for (let x = 0; x < k; x++) c[i][j] += a[i][x] * b[x][j];
  return c;
}
function dense(entries: { i: number; j: number; value: bigint }[], rows: number, cols: number): bigint[][] {
  const d: bigint[][] = Array.from({ length: rows }, () => new Array(cols).fill(0n));
  for (const e of entries) d[e.i][e.j] += e.value;
  return d;
}
function toEntries(d: bigint[][]) {
  const out: { i: number; j: number; value: string }[] = [];
  d.forEach((row, i) => row.forEach((v, j) => { if (v !== 0n) out.push({ i, j, value: v.toString(10) }); }));
  return out;
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-test-"));
  svc = new MatrixService(dir);
});
after(() => {
  svc.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("规范化:重复坐标相消、负数、空行、稳定排序", () => {
  const m = svc.createMatrix("norm", 3, 3, [
    { i: 2, j: 1, value: "-4" },
    { i: 0, j: 0, value: "5" },
    { i: 0, j: 0, value: "-5" }, // 相消
    { i: 1, j: 2, value: "3" },
    { i: 1, j: 2, value: "1" },  // 合并为 4
  ]);
  const e = svc.getEntries("norm", m.version).entries;
  assert.deepEqual(e, [
    { i: 1, j: 2, value: "4" },
    { i: 2, j: 1, value: "-4" },
  ]);
  const csr = svc.getCsr("norm", m.version);
  assert.deepEqual(csr.rowPtr, [0, 0, 1, 2]); // 空行 0 指针不变,末尾 = nnz
  assert.deepEqual(csr.colIdx, [2, 1]);
  assert.deepEqual(csr.values, ["4", "-4"]);
});

test("零矩阵:空元素列表", () => {
  const m = svc.createMatrix("zero", 4, 5, []);
  assert.equal(m.nnz, 0);
  const csr = svc.getCsr("zero", m.version);
  assert.deepEqual(csr.rowPtr, [0, 0, 0, 0, 0]);
});

test("单位矩阵乘任意矩阵等于其自身", () => {
  const id = svc.createMatrix("I", 3, 3, [
    { i: 0, j: 0, value: "1" }, { i: 1, j: 1, value: "1" }, { i: 2, j: 2, value: "1" },
  ]);
  const x = svc.createMatrix("X", 3, 2, [
    { i: 0, j: 1, value: "7" }, { i: 2, j: 0, value: "-9" },
  ]);
  svc.multiply("I", id.version, "X", x.version, "IX");
  assert.deepEqual(svc.getResult("IX").entries, svc.getEntries("X", x.version).entries);
});

test("矩形维度乘法与稠密参照一致", () => {
  const ea = [
    { i: 0, j: 0, value: 2n }, { i: 0, j: 3, value: -1n },
    { i: 2, j: 1, value: 5n }, { i: 4, j: 2, value: 3n },
  ];
  const eb = [
    { i: 0, j: 0, value: 1n }, { i: 1, j: 2, value: -2n },
    { i: 2, j: 1, value: 4n }, { i: 3, j: 0, value: 6n },
  ];
  const a = svc.createMatrix("RA", 5, 4, ea.map((e) => ({ ...e, value: e.value.toString() })));
  const b = svc.createMatrix("RB", 4, 3, eb.map((e) => ({ ...e, value: e.value.toString() })));
  svc.multiply("RA", a.version, "RB", b.version, "RAB");
  const expected = toEntries(denseMultiply(dense(ea, 5, 4), dense(eb, 4, 3)));
  assert.deepEqual(svc.getResult("RAB").entries, expected);
});

test("多个贡献相消后结果为零项被移除", () => {
  const a = svc.createMatrix("CA", 1, 2, [{ i: 0, j: 0, value: "2" }, { i: 0, j: 1, value: "3" }]);
  const b = svc.createMatrix("CB", 2, 1, [{ i: 0, j: 0, value: "3" }, { i: 1, j: 0, value: "-2" }]);
  const r = svc.multiply("CA", a.version, "CB", b.version, "CAB");
  assert.equal(r.nnz, 0); // 2*3 + 3*(-2) = 0
  assert.deepEqual(svc.getResult("CAB").entries, []);
  const el = svc.getResultElement("CAB", 0, 0);
  assert.equal(el.value, "0");
  assert.equal(el.terms.length, 2);
});

test("超出安全整数范围的合法值精确计算", () => {
  const big = "9007199254740993"; // 2^53+1
  const a = svc.createMatrix("BA", 1, 1, [{ i: 0, j: 0, value: big }]);
  const b = svc.createMatrix("BB", 1, 1, [{ i: 0, j: 0, value: big }]);
  svc.multiply("BA", a.version, "BB", b.version, "BAB");
  const expected = (BigInt(big) * BigInt(big)).toString(10);
  assert.deepEqual(svc.getResult("BAB").entries, [{ i: 0, j: 0, value: expected }]);
});

test("元素来源逐项乘加", () => {
  const a = svc.createMatrix("PA", 2, 2, [{ i: 0, j: 0, value: "1" }, { i: 0, j: 1, value: "2" }]);
  const b = svc.createMatrix("PB", 2, 2, [{ i: 0, j: 0, value: "3" }, { i: 1, j: 0, value: "4" }]);
  svc.multiply("PA", a.version, "PB", b.version, "PAB");
  const el = svc.getResultElement("PAB", 0, 0);
  assert.equal(el.value, "11");
  assert.deepEqual(el.terms, [
    { k: 0, a: "1", b: "3", product: "3" },
    { k: 1, a: "2", b: "4", product: "8" },
  ]);
});

test("错误输入被明确拒绝", () => {
  assert.throws(() => svc.createMatrix("bad1", 2, 2, [{ i: 2, j: 0, value: "1" }]), (e: any) => e instanceof ApiError && e.code === "OUT_OF_BOUNDS");
  assert.throws(() => svc.createMatrix("bad2", 2, 2, [{ i: 0, j: 0, value: "1.5" }]), (e: any) => e instanceof ApiError && e.code === "NOT_INTEGER");
  assert.throws(() => svc.createMatrix("bad3", 2, 2, [{ i: 0, j: 0, value: 2 ** 60 }]), (e: any) => e instanceof ApiError && e.code === "UNSAFE_INTEGER");
  assert.throws(() => svc.createMatrix("bad4", 20000, 2, []), (e: any) => e instanceof ApiError && e.code === "LIMIT_EXCEEDED");
  const a = svc.createMatrix("DA", 2, 3, []);
  const b = svc.createMatrix("DB", 4, 2, []);
  assert.throws(() => svc.multiply("DA", a.version, "DB", b.version, "DX"), (e: any) => e instanceof ApiError && e.code === "DIMENSION_MISMATCH");
  assert.throws(() => svc.getResultElement("PAB", 5, 0), (e: any) => e instanceof ApiError && e.code === "OUT_OF_BOUNDS");
});

test("版本比较", () => {
  svc.createMatrix("VC", 2, 2, [{ i: 0, j: 0, value: "1" }], 1);
  svc.createMatrix("VC", 2, 2, [{ i: 0, j: 0, value: "2" }, { i: 1, j: 1, value: "5" }], 2);
  const diff = svc.compareVersions("VC", 1, 2);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.changed, [{ i: 0, j: 0, from: "1", to: "2" }]);
  assert.deepEqual(diff.added, [{ i: 1, j: 1, value: "5" }]);
  assert.equal(diff.removed.length, 0);
});

test("结果绑定确定输入版本,重启后仍可查询且不受新输入影响", () => {
  const a1 = svc.createMatrix("RA1", 1, 1, [{ i: 0, j: 0, value: "2" }]);
  const b1 = svc.createMatrix("RB1", 1, 1, [{ i: 0, j: 0, value: "3" }]);
  svc.multiply("RA1", a1.version, "RB1", b1.version, "PERSIST");
  // 之后创建新版本输入
  svc.createMatrix("RA1", 1, 1, [{ i: 0, j: 0, value: "99" }]);
  svc.close();
  svc = new MatrixService(dir); // 模拟重启
  const r = svc.getResult("PERSIST");
  assert.deepEqual(r.entries, [{ i: 0, j: 0, value: "6" }]);
  assert.deepEqual(r.inputs.a, { name: "RA1", version: 1 });
});

test("结果非零项不重复且顺序稳定", () => {
  const r = svc.getResult("RAB", 10000).entries;
  const keys = r.map((e) => e.i + "," + e.j);
  assert.equal(new Set(keys).size, keys.length);
  const sorted = [...r].sort((x, y) => (x.i - y.i) || (x.j - y.j));
  assert.deepEqual(r, sorted);
});

test("结果数量上限", () => {
  const r = svc.getResult("RAB", 1);
  assert.equal(r.entries.length, 1);
  assert.equal(r.limit, 1);
  assert.ok(r.nnz >= 1);
});
