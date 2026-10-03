import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ApiError, Entry, EntryInput, LIMITS,
  normalizeEntries, toCsr, multiplyEntries, elementProvenance, parseDim,
} from "./core";

export class MatrixService {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "matrices.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS matrices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        rows INTEGER NOT NULL,
        cols INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(name, version)
      );
      CREATE TABLE IF NOT EXISTS entries (
        matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
        i INTEGER NOT NULL, j INTEGER NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (matrix_id, i, j)
      );
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        a_matrix_id INTEGER NOT NULL REFERENCES matrices(id),
        b_matrix_id INTEGER NOT NULL REFERENCES matrices(id),
        rows INTEGER NOT NULL, cols INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS result_entries (
        result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
        i INTEGER NOT NULL, j INTEGER NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (result_id, i, j)
      );
    `);
  }

  close() { this.db.close(); }

  createMatrix(name: string, rows: unknown, cols: unknown, rawEntries: EntryInput[], version?: number) {
    if (!name || typeof name !== "string") throw new ApiError("BAD_NAME", "矩阵名称必须是非空字符串");
    const r = parseDim(rows, "行数");
    const c = parseDim(cols, "列数");
    const entries = normalizeEntries(rawEntries ?? [], r, c);
    let v: number;
    if (version == null) {
      const row = this.db.prepare("SELECT MAX(version) AS mv FROM matrices WHERE name = ?").get(name) as any;
      v = (row?.mv ?? 0) + 1;
    } else v = version;
    if (!Number.isInteger(v) || v < 1) throw new ApiError("BAD_VERSION", "版本号必须是正整数");
    const existing = this.db.prepare("SELECT id FROM matrices WHERE name = ? AND version = ?").get(name, v);
    if (existing) throw new ApiError("VERSION_EXISTS", `矩阵 ${name} 版本 ${v} 已存在`, 409);
    const insertM = this.db.prepare("INSERT INTO matrices (name, version, rows, cols) VALUES (?, ?, ?, ?)");
    const insertE = this.db.prepare("INSERT INTO entries (matrix_id, i, j, value) VALUES (?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      const res = insertM.run(name, v, r, c);
      const id = Number(res.lastInsertRowid);
      for (const e of entries) insertE.run(id, e.i, e.j, e.value.toString(10));
      this.db.exec("COMMIT");
      return { id, name, version: v, rows: r, cols: c, nnz: entries.length };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private getMatrixRow(name: string, version: number) {
    const row = this.db.prepare("SELECT * FROM matrices WHERE name = ? AND version = ?").get(name, version) as any;
    if (!row) throw new ApiError("NOT_FOUND", `矩阵 ${name} 版本 ${version} 不存在`, 404);
    return row;
  }

  private loadEntries(matrixId: number): Entry[] {
    const rows = this.db.prepare("SELECT i, j, value FROM entries WHERE matrix_id = ? ORDER BY i, j").all(matrixId) as any[];
    return rows.map((r) => ({ i: r.i, j: r.j, value: BigInt(r.value) }));
  }

  listVersions(name: string) {
    return this.db.prepare("SELECT version, rows, cols, created_at, (SELECT COUNT(*) FROM entries e WHERE e.matrix_id = m.id) AS nnz FROM matrices m WHERE name = ? ORDER BY version").all(name);
  }

  getEntries(name: string, version: number, limit = LIMITS.DEFAULT_RESULT_LIMIT, offset = 0) {
    const m = this.getMatrixRow(name, version);
    const lim = Math.min(Math.max(1, limit), LIMITS.MAX_RESULT_LIMIT);
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM entries WHERE matrix_id = ?").get(m.id) as any).c;
    const rows = (this.db.prepare("SELECT i, j, value FROM entries WHERE matrix_id = ? ORDER BY i, j LIMIT ? OFFSET ?").all(m.id, lim, offset) as any[]).map((r) => ({ i: r.i, j: r.j, value: String(r.value) }));
    return { name, version, rows: m.rows, cols: m.cols, nnz: total, limit: lim, offset, entries: rows };
  }

  getCsr(name: string, version: number) {
    const m = this.getMatrixRow(name, version);
    const csr = toCsr(this.loadEntries(m.id), m.rows);
    return { name, version, rows: m.rows, cols: m.cols, ...csr };
  }

  multiply(aName: string, aVersion: number, bName: string, bVersion: number, resultName: string) {
    if (!resultName) throw new ApiError("BAD_NAME", "结果名称不能为空");
    const a = this.getMatrixRow(aName, aVersion);
    const b = this.getMatrixRow(bName, bVersion);
    if (a.cols !== b.rows)
      throw new ApiError("DIMENSION_MISMATCH", `A 的列数(${a.cols})不等于 B 的行数(${b.rows})`);
    if (this.db.prepare("SELECT id FROM results WHERE name = ?").get(resultName))
      throw new ApiError("RESULT_EXISTS", `结果 ${resultName} 已存在`, 409);
    const entries = multiplyEntries(this.loadEntries(a.id), this.loadEntries(b.id), a.cols, b.rows);
    const insertR = this.db.prepare("INSERT INTO results (name, a_matrix_id, b_matrix_id, rows, cols) VALUES (?, ?, ?, ?, ?)");
    const insertE = this.db.prepare("INSERT INTO result_entries (result_id, i, j, value) VALUES (?, ?, ?, ?)");
    // 元信息与非零元素在同一事务提交,失败不留下半矩阵
    this.db.exec("BEGIN");
    try {
      const res = insertR.run(resultName, a.id, b.id, a.rows, b.cols);
      const id = Number(res.lastInsertRowid);
      for (const e of entries) insertE.run(id, e.i, e.j, e.value.toString(10));
      this.db.exec("COMMIT");
      return {
        id, name: resultName, rows: a.rows, cols: b.cols, nnz: entries.length,
        inputs: {
          a: { name: aName, version: aVersion },
          b: { name: bName, version: bVersion },
        },
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private getResultRow(name: string) {
    const row = this.db.prepare("SELECT * FROM results WHERE name = ?").get(name) as any;
    if (!row) throw new ApiError("NOT_FOUND", `结果 ${name} 不存在`, 404);
    return row;
  }

  getResult(name: string, limit = LIMITS.DEFAULT_RESULT_LIMIT, offset = 0) {
    const r = this.getResultRow(name);
    const lim = Math.min(Math.max(1, limit), LIMITS.MAX_RESULT_LIMIT);
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM result_entries WHERE result_id = ?").get(r.id) as any).c;
    const rows = (this.db.prepare("SELECT i, j, value FROM result_entries WHERE result_id = ? ORDER BY i, j LIMIT ? OFFSET ?").all(r.id, lim, offset) as any[]).map((x) => ({ i: x.i, j: x.j, value: String(x.value) }));
    const a = this.db.prepare("SELECT name, version FROM matrices WHERE id = ?").get(r.a_matrix_id) as any;
    const b = this.db.prepare("SELECT name, version FROM matrices WHERE id = ?").get(r.b_matrix_id) as any;
    return {
      name, rows: r.rows, cols: r.cols, nnz: total, limit: lim, offset,
      inputs: { a: { name: a.name, version: a.version }, b: { name: b.name, version: b.version } },
      created_at: r.created_at, entries: rows,
    };
  }

  getResultCsr(name: string) {
    const r = this.getResultRow(name);
    const rows = this.db.prepare("SELECT i, j, value FROM result_entries WHERE result_id = ? ORDER BY i, j").all(r.id) as any[];
    const entries: Entry[] = rows.map((x) => ({ i: x.i, j: x.j, value: BigInt(x.value) }));
    return { name, rows: r.rows, cols: r.cols, ...toCsr(entries, r.rows) };
  }

  getResultElement(name: string, i: number, j: number) {
    const r = this.getResultRow(name);
    if (i < 0 || i >= r.rows || j < 0 || j >= r.cols)
      throw new ApiError("OUT_OF_BOUNDS", `坐标 (${i},${j}) 越界(结果 ${r.rows}×${r.cols})`);
    const a = this.loadEntries(r.a_matrix_id);
    const b = this.loadEntries(r.b_matrix_id);
    return { result: name, ...elementProvenance(a, b, i, j) };
  }

  compareVersions(name: string, v1: number, v2: number) {
    const m1 = this.getMatrixRow(name, v1);
    const m2 = this.getMatrixRow(name, v2);
    const e1 = this.loadEntries(m1.id);
    const e2 = this.loadEntries(m2.id);
    const map1 = new Map(e1.map((e) => [e.i + "," + e.j, e.value]));
    const map2 = new Map(e2.map((e) => [e.i + "," + e.j, e.value]));
    const added: any[] = [], removed: any[] = [], changed: any[] = [];
    for (const [k, v] of map2) {
      const [i, j] = k.split(",").map(Number);
      if (!map1.has(k)) added.push({ i, j, value: v.toString(10) });
      else if (map1.get(k) !== v) changed.push({ i, j, from: map1.get(k)!.toString(10), to: v.toString(10) });
    }
    for (const [k, v] of map1) {
      if (!map2.has(k)) {
        const [i, j] = k.split(",").map(Number);
        removed.push({ i, j, value: v.toString(10) });
      }
    }
    return {
      name, v1, v2,
      dims: { v1: { rows: m1.rows, cols: m1.cols }, v2: { rows: m2.rows, cols: m2.cols } },
      identical: added.length === 0 && removed.length === 0 && changed.length === 0 && m1.rows === m2.rows && m1.cols === m2.cols,
      added, removed, changed,
    };
  }
}
