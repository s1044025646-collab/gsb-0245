import * as path from "node:path";
import * as fs from "node:fs";
import { MatrixService } from "./service";
import { startServer } from "./api";

const DATA_DIR = process.env.MATRIX_DATA_DIR ?? path.join(process.cwd(), "data");

function out(x: unknown) { console.log(JSON.stringify(x, null, 2)); }

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function usage(): never {
  console.error(`用法:
  node dist/src/cli.js serve [--port N]            启动 HTTP 服务(默认端口 0 = 自动选空闲端口)
  node dist/src/cli.js create <file.json>          从 JSON 文件创建矩阵 {name,rows,cols,entries:[{i,j,value}]}
  node dist/src/cli.js versions <name>             列出矩阵版本
  node dist/src/cli.js entries <name> <version>    查看规范化三元组
  node dist/src/cli.js csr <name> <version>        查看 CSR 行压缩结构
  node dist/src/cli.js multiply <a> <av> <b> <bv> <resultName>   执行乘法
  node dist/src/cli.js result <name>               查看结果
  node dist/src/cli.js element <result> <i> <j>    查看结果元素的逐项来源乘积
  node dist/src/cli.js compare <name> <v1> <v2>    比较两个版本
  node dist/src/cli.js export <result> [entries|csr]  导出结果`);
  process.exit(1);
}

const args = process.argv.slice(2);
const cmd = args[0];
if (!cmd) usage();

if (cmd === "serve") {
  const pi = args.indexOf("--port");
  const port = pi >= 0 ? Number(args[pi + 1]) : Number(process.env.PORT ?? 0);
  startServer(DATA_DIR, Number.isInteger(port) && port >= 0 ? port : 0).then(({ port }) => {
    console.log(`稀疏矩阵服务已启动: http://127.0.0.1:${port}  (数据目录: ${DATA_DIR})`);
  });
} else {
  const svc = new MatrixService(DATA_DIR);
  try {
    switch (cmd) {
      case "create": {
        const spec = readJson(args[1]);
        out(svc.createMatrix(spec.name, spec.rows, spec.cols, spec.entries ?? [], spec.version));
        break;
      }
      case "versions": out(svc.listVersions(args[1])); break;
      case "entries": out(svc.getEntries(args[1], Number(args[2]))); break;
      case "csr": out(svc.getCsr(args[1], Number(args[2]))); break;
      case "multiply": out(svc.multiply(args[1], Number(args[2]), args[3], Number(args[4]), args[5])); break;
      case "result": out(svc.getResult(args[1])); break;
      case "element": out(svc.getResultElement(args[1], Number(args[2]), Number(args[3]))); break;
      case "compare": out(svc.compareVersions(args[1], Number(args[2]), Number(args[3]))); break;
      case "export": {
        const fmt = args[2] ?? "entries";
        out(fmt === "csr" ? svc.getResultCsr(args[1]) : svc.getResult(args[1]));
        break;
      }
      default: usage();
    }
  } catch (err: any) {
    if (err.code) { console.error(`错误 [${err.code}] ${err.message}`); process.exit(2); }
    throw err;
  } finally {
    svc.close();
  }
}
