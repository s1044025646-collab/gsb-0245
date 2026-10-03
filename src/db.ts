import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ApiError } from "./errors";
import { Triple } from "./matrix";

export const DATA_DIR = path.join(process.cwd(), "data");
export const DB_PATH = path.join(DATA_DIR, "matrices.db");

export function openDb(dbPath: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS matrices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      rows INTEGER NOT NULL,
      cols INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, version)
    );
    CREATE TABLE IF NOT EXISTS elements (
      matrix_id INTEGER NOT NULL REFERENCES matrices(id),
      row INTEGER NOT NULL,
      col INTEGER NOT NULL,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_elements_matrix ON elements(matrix_id, row, col);
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      a_matrix_id INTEGER NOT NULL REFERENCES matrices(id),
      b_matrix_id INTEGER NOT NULL REFERENCES matrices(id),
      rows INTEGER NOT NULL,
      cols INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS product_elements (
      product_id INTEGER NOT NULL REFERENCES products(id),
      row INTEGER NOT NULL,
      col INTEGER NOT NULL,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_product_elements ON product_elements(product_id, row, col);
  `);
  return db;
}

export interface MatrixRow {
  id: number;
  name: string;
  version: string;
  rows: number;
  cols: number;
  created_at: string;
}

export function insertMatrix(
  db: DatabaseSync,
  name: string,
  version: string,
  rows: number,
  cols: number,
  triples: Triple[]
): number {
  const existing = db
    .prepare("SELECT id FROM matrices WHERE name = ? AND version = ?")
    .get(name, version);
  if (existing) {
    throw new ApiError(
      "DUPLICATE_VERSION",
      `矩阵 "${name}" 版本 "${version}" 已存在（版本不可变，请使用新版本号）`,
      409
    );
  }
  // 元信息与非零元素在同一事务中提交，失败不留半矩阵
  db.exec("BEGIN");
  try {
    const res = db
      .prepare("INSERT INTO matrices(name, version, rows, cols) VALUES (?, ?, ?, ?)")
      .run(name, version, rows, cols);
    const id = Number(res.lastInsertRowid);
    const stmt = db.prepare(
      "INSERT INTO elements(matrix_id, row, col, value) VALUES (?, ?, ?, ?)"
    );
    for (const t of triples) {
      stmt.run(id, t.row, t.col, t.value.toString());
    }
    db.exec("COMMIT");
    return id;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getMatrix(db: DatabaseSync, name: string, version: string): MatrixRow {
  const m = db
    .prepare("SELECT * FROM matrices WHERE name = ? AND version = ?")
    .get(name, version) as unknown as MatrixRow | undefined;
  if (!m) {
    throw new ApiError("NOT_FOUND", `矩阵 "${name}" 版本 "${version}" 不存在`, 404);
  }
  return m;
}

export function getMatrixById(db: DatabaseSync, id: number): MatrixRow {
  const m = db.prepare("SELECT * FROM matrices WHERE id = ?").get(id) as unknown as
    | MatrixRow
    | undefined;
  if (!m) throw new ApiError("NOT_FOUND", `矩阵 id=${id} 不存在`, 404);
  return m;
}

export function loadTriples(db: DatabaseSync, matrixId: number): Triple[] {
  const rows = db
    .prepare("SELECT row, col, value FROM elements WHERE matrix_id = ? ORDER BY row, col")
    .all(matrixId) as unknown as { row: number; col: number; value: string }[];
  return rows.map((r) => ({ row: r.row, col: r.col, value: BigInt(r.value) }));
}

export function insertProduct(
  db: DatabaseSync,
  aId: number,
  bId: number,
  rows: number,
  cols: number,
  triples: Triple[]
): number {
  db.exec("BEGIN");
  try {
    const res = db
      .prepare("INSERT INTO products(a_matrix_id, b_matrix_id, rows, cols) VALUES (?, ?, ?, ?)")
      .run(aId, bId, rows, cols);
    const id = Number(res.lastInsertRowid);
    const stmt = db.prepare(
      "INSERT INTO product_elements(product_id, row, col, value) VALUES (?, ?, ?, ?)"
    );
    for (const t of triples) {
      stmt.run(id, t.row, t.col, t.value.toString());
    }
    db.exec("COMMIT");
    return id;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface ProductRow {
  id: number;
  a_matrix_id: number;
  b_matrix_id: number;
  rows: number;
  cols: number;
  created_at: string;
}

export function getProduct(db: DatabaseSync, id: number): ProductRow {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(id) as unknown as
    | ProductRow
    | undefined;
  if (!p) throw new ApiError("NOT_FOUND", `乘积 id=${id} 不存在`, 404);
  return p;
}

export function loadProductTriples(db: DatabaseSync, productId: number): Triple[] {
  const rows = db
    .prepare(
      "SELECT row, col, value FROM product_elements WHERE product_id = ? ORDER BY row, col"
    )
    .all(productId) as unknown as { row: number; col: number; value: string }[];
  return rows.map((r) => ({ row: r.row, col: r.col, value: BigInt(r.value) }));
}
