import * as http from "node:http";
import { MatrixService } from "./service";
import { ApiError } from "./core";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { reject(new ApiError("LIMIT_EXCEEDED", "请求体过大", 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new ApiError("BAD_JSON", "请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

function num(v: string | null, field: string): number {
  if (v == null || !/^-?\d+$/.test(v)) throw new ApiError("BAD_PARAM", `参数 ${field} 必须是整数`);
  return Number(v);
}

export function createServer(service: MatrixService) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const q = url.searchParams;
      const limit = q.get("limit") ? num(q.get("limit"), "limit") : undefined;
      const offset = q.get("offset") ? num(q.get("offset"), "offset") : undefined;

      if (method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

      if (method === "POST" && url.pathname === "/matrices") {
        const b = await readBody(req);
        return send(res, 201, service.createMatrix(b.name, b.rows, b.cols, b.entries ?? [], b.version));
      }
      if (method === "GET" && parts[0] === "matrices" && parts.length === 2)
        return send(res, 200, service.listVersions(decodeURIComponent(parts[1])));
      if (method === "GET" && parts[0] === "matrices" && parts.length === 4 && parts[3] === "entries")
        return send(res, 200, service.getEntries(decodeURIComponent(parts[1]), num(parts[2], "version"), limit, offset));
      if (method === "GET" && parts[0] === "matrices" && parts.length === 4 && parts[3] === "csr")
        return send(res, 200, service.getCsr(decodeURIComponent(parts[1]), num(parts[2], "version")));
      if (method === "GET" && parts[0] === "matrices" && parts.length === 4 && parts[3] === "compare")
        return send(res, 200, service.compareVersions(decodeURIComponent(parts[1]), num(q.get("v1"), "v1"), num(q.get("v2"), "v2")));

      if (method === "POST" && url.pathname === "/multiply") {
        const b = await readBody(req);
        if (!b.a || !b.b) throw new ApiError("BAD_PARAM", "需要 a 和 b 两个输入矩阵 {name, version}");
        return send(res, 201, service.multiply(b.a.name, num(String(b.a.version), "a.version"), b.b.name, num(String(b.b.version), "b.version"), b.resultName));
      }
      if (method === "GET" && parts[0] === "results" && parts.length === 2)
        return send(res, 200, service.getResult(decodeURIComponent(parts[1]), limit, offset));
      if (method === "GET" && parts[0] === "results" && parts.length === 3 && parts[2] === "csr")
        return send(res, 200, service.getResultCsr(decodeURIComponent(parts[1])));
      if (method === "GET" && parts[0] === "results" && parts.length === 3 && parts[2] === "element")
        return send(res, 200, service.getResultElement(decodeURIComponent(parts[1]), num(q.get("i"), "i"), num(q.get("j"), "j")));
      if (method === "GET" && parts[0] === "results" && parts.length === 3 && parts[2] === "export") {
        const fmt = q.get("format") ?? "entries";
        const data = fmt === "csr" ? service.getResultCsr(decodeURIComponent(parts[1])) : service.getResult(decodeURIComponent(parts[1]), limit, offset);
        return send(res, 200, { format: fmt, ...data });
      }

      throw new ApiError("NOT_FOUND", `未知路由: ${method} ${url.pathname}`, 404);
    } catch (err: any) {
      if (err instanceof ApiError) return send(res, err.status, { error: { code: err.code, message: err.message } });
      send(res, 500, { error: { code: "INTERNAL", message: String(err?.message ?? err) } });
    }
  });
}

export function startServer(dataDir: string, port: number) {
  const service = new MatrixService(dataDir);
  const server = createServer(service);
  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolve({ server, port: addr.port });
    });
  });
}
