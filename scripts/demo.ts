// 演示：两个小矩阵（含空行、重复坐标相消、负数），展示规范化、CSR 与逐项乘加。
import * as fs from "node:fs";
import { openDb, DB_PATH } from "../src/db";
import * as svc from "../src/service";

// 演示使用独立数据库，每次运行前重置
const demoDbPath = DB_PATH.replace(/matrices\.db$/, "demo.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(demoDbPath + suffix); } catch {}
}
const db = openDb(demoDbPath);


function show(title: string, v: unknown) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(v, null, 2));
}

// A: 3x3，含重复坐标（(0,1): 4 + -4 相消）、负数、空行（第 2 行）
const a = svc.createMatrix(db, {
  name: "demoA",
  version: "v1",
  rows: 3,
  cols: 3,
  elements: [
    { row: 0, col: 0, value: "2" },
    { row: 0, col: 1, value: "4" },
    { row: 0, col: 1, value: "-4" },
    { row: 1, col: 1, value: "-3" },
    { row: 1, col: 2, value: "5" },
  ],
});
show("A 规范化后（重复坐标相消，(0,1) 消失）", a);
show("A 的 CSR（第 2 行为空行，rowPtr[2]==rowPtr[3]）", svc.getCsr(db, "demoA", "v1"));

// B: 3x2，含负数
const b = svc.createMatrix(db, {
  name: "demoB",
  version: "v1",
  rows: 3,
  cols: 2,
  elements: [
    { row: 0, col: 0, value: "1" },
    { row: 1, col: 0, value: "-2" },
    { row: 1, col: 1, value: "7" },
    { row: 2, col: 1, value: "3" },
  ],
});
show("B 规范化后", b);

const p = svc.multiplyMatrices(db, {
  a: { name: "demoA", version: "v1" },
  b: { name: "demoB", version: "v1" },
});
show("乘积元信息", p);
show("乘积三元组", svc.getProductElements(db, p.id));
show("乘积 CSR", svc.getProductCsr(db, p.id));
show("C[1,0] 与 C[1,1] 的逐项来源", {
  c10: svc.explainProductElement(db, p.id, 1, 0),
  c11: svc.explainProductElement(db, p.id, 1, 1),
});
db.close();

