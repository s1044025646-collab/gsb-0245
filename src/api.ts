import * as http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors";
import * as svc from "./service";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(new ApiError("LIMIT_EXCEEDED", "请求体超过 10MB 上限", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("BAD_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function num(s: string | null): number | undefined {
  return s === null ? undefined : Number(s);
}

export function createServer(db: DatabaseSync): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const q = url.searchParams;
      const method = req.method ?? "GET";

      if (method === "GET" && parts[0] === "health") {
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && parts[0] === "matrices" && parts.length === 1) {
        return send(res, 201, svc.createMatrix(db, await readBody(req)));
      }
      if (method === "GET" && parts[0] === "matrices" && parts.length === 1) {
        return send(res, 200, svc.listMatrices(db));
      }
      if (method === "GET" && parts[0] === "matrices" && parts.length === 3) {
        return send(res, 200, svc.getElements(db, parts[1], parts[2], num(q.get("limit")), num(q.get("offset"))));
      }
      if (method === "GET" && parts[0] === "matrices" && parts[3] === "csr" && parts.length === 4) {
        return send(res, 200, svc.getCsr(db, parts[1], parts[2]));
      }
      if (method === "GET" && parts[0] === "matrices" && parts[3] === "export" && parts.length === 4) {
        return send(res, 200, svc.exportMatrix(db, parts[1], parts[2], q.get("format") ?? "triples"));
      }
      if (method === "GET" && parts[0] === "matrices" && parts[2] === "compare" && parts.length === 3) {
        const from = q.get("from");
        const to = q.get("to");
        if (!from || !to) throw new ApiError("BAD_REQUEST", "需要 ?from=<v1>&to=<v2>");
        return send(res, 200, svc.compareVersions(db, parts[1], from, to));
      }
      if (method === "POST" && parts[0] === "multiply" && parts.length === 1) {
        return send(res, 201, svc.multiplyMatrices(db, await readBody(req)));
      }
      if (method === "GET" && parts[0] === "products" && parts.length === 2) {
        return send(res, 200, svc.getProductElements(db, Number(parts[1]), num(q.get("limit")), num(q.get("offset"))));
      }
      if (method === "GET" && parts[0] === "products" && parts[2] === "csr" && parts.length === 3) {
        return send(res, 200, svc.getProductCsr(db, Number(parts[1])));
      }
      if (method === "GET" && parts[0] === "products" && parts[2] === "element" && parts.length === 3) {
        return send(res, 200, svc.explainProductElement(db, Number(parts[1]), q.get("i") !== null ? Number(q.get("i")) : undefined, q.get("j") !== null ? Number(q.get("j")) : undefined));
      }
      if (method === "GET" && parts[0] === "products" && parts[2] === "export" && parts.length === 3) {
        return send(res, 200, svc.exportProduct(db, Number(parts[1]), q.get("format") ?? "triples"));
      }
      throw new ApiError("NOT_FOUND", `未知路由 ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        return send(res, e.status, { error: { code: e.code, message: e.message } });
      }
      return send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

/** 启动服务器；port=0 时由系统分配空闲端口。 */
export function serve(db: DatabaseSync, port: number): Promise<number> {
  const server = createServer(db);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(`稀疏矩阵服务已启动: http://127.0.0.1:${actual}`);
      resolve(actual);
    });
  });
}

