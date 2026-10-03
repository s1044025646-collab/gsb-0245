// 演示:含空行、重复坐标相消和负数的两个小矩阵
import * as path from "node:path";
import * as fs from "node:fs";
import { MatrixService } from "./service";

const dir = path.join(process.cwd(), "data-demo");
fs.rmSync(dir, { recursive: true, force: true });
const svc = new MatrixService(dir);

console.log("=== 创建矩阵 A (3x4):含空行、重复坐标相消、负数 ===");
// (0,0)=2 出现两次(+5,-5)相消;(0,1)=-3;(2,3)=7;第 1 行为空行
const a = svc.createMatrix("A", 3, 4, [
  { i: 0, j: 0, value: "5" },
  { i: 0, j: 0, value: "-5" },
  { i: 0, j: 1, value: "-3" },
  { i: 2, j: 3, value: "7" },
  { i: 2, j: 0, value: "4" },
]);
console.log(JSON.stringify(a));
console.log("规范化三元组:", JSON.stringify(svc.getEntries("A", a.version).entries));
console.log("CSR:", JSON.stringify(svc.getCsr("A", a.version)));

console.log("\n=== 创建矩阵 B (4x2) ===");
const b = svc.createMatrix("B", 4, 2, [
  { i: 1, j: 0, value: "2" },
  { i: 1, j: 1, value: "-1" },
  { i: 3, j: 1, value: "6" },
  { i: 0, j: 1, value: "10" },
]);
console.log(JSON.stringify(b));
console.log("规范化三元组:", JSON.stringify(svc.getEntries("B", b.version).entries));
console.log("CSR:", JSON.stringify(svc.getCsr("B", b.version)));

console.log("\n=== C = A * B ===");
const c = svc.multiply("A", a.version, "B", b.version, "C_demo");
console.log(JSON.stringify(c));
console.log("结果三元组:", JSON.stringify(svc.getResult("C_demo").entries));
console.log("结果 CSR:", JSON.stringify(svc.getResultCsr("C_demo")));

console.log("\n=== 元素 C[0,1] 的逐项来源乘积 ===");
console.log(JSON.stringify(svc.getResultElement("C_demo", 0, 1), null, 2));
console.log("\n=== 元素 C[2,1] 的逐项来源乘积 ===");
console.log(JSON.stringify(svc.getResultElement("C_demo", 2, 1), null, 2));

svc.close();
console.log("\n演示完成,数据保存在 data-demo/");
