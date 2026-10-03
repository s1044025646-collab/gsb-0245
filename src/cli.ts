import * as fs from "node:fs";
import { openDb } from "./db";
import { serve } from "./api";
import * as svc from "./service";
import { ApiError } from "./errors";

const USAGE = `稀疏整数矩阵服务 CLI

用法: node dist/cli.js <命令> [参数]

服务:
  serve [--port N]                     启动 HTTP API（默认 0 = 自动选空闲端口）

矩阵:
  create <file.json>                   从 JSON 文件创建矩阵 {name,version,rows,cols,elements:[{row,col,value}]}
  list                                 列出所有矩阵版本
  show <name> <version> [--limit N] [--offset N]   查看规范化三元组
  csr <name> <version>                 查看 CSR 行压缩结构
  compare <name> <v1> <v2>             比较两个版本
  export <name> <version> [triples|csr]            导出矩阵

乘法:
  multiply <aName> <aVer> <bName> <bVer>           计算乘积，输出 productId
  product <id> [--limit N]             查看乘积三元组
  product-csr <id>                     查看乘积 CSR
  element <productId> <i> <j>          查看 C[i,j] 的逐项来源乘积
  product-export <id> [triples|csr]    导出乘积
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function numFlag(args: string[], name: string): number | undefined {
  const v = flag(args, name);
  return v === undefined ? undefined : Number(v);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  const db = openDb();
  try {
    switch (cmd) {
      case "serve": {
        const port = Number(flag(args, "--port") ?? process.env.PORT ?? 0);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new ApiError("BAD_REQUEST", "--port 必须是 0..65535 的整数（0 表示自动选择空闲端口）");
        }
        await serve(db, port);
        return;
      }
      case "create": {
        const file = args[0];
        if (!file) throw new ApiError("BAD_REQUEST", "缺少 JSON 文件路径");
        const body = JSON.parse(fs.readFileSync(file, "utf8"));
        console.log(JSON.stringify(svc.createMatrix(db, body), null, 2));
        break;
      }
      case "list":
        console.log(JSON.stringify(svc.listMatrices(db), null, 2));
        break;
      case "show":
        console.log(JSON.stringify(svc.getElements(db, args[0], args[1], numFlag(args, "--limit"), numFlag(args, "--offset")), null, 2));
        break;
      case "csr":
        console.log(JSON.stringify(svc.getCsr(db, args[0], args[1]), null, 2));
        break;
      case "compare":
        console.log(JSON.stringify(svc.compareVersions(db, args[0], args[1], args[2]), null, 2));
        break;
      case "export":
        console.log(JSON.stringify(svc.exportMatrix(db, args[0], args[1], args[2] ?? "triples"), null, 2));
        break;
      case "multiply":
        console.log(JSON.stringify(svc.multiplyMatrices(db, {
          a: { name: args[0], version: args[1] },
          b: { name: args[2], version: args[3] },
        }), null, 2));
        break;
      case "product":
        console.log(JSON.stringify(svc.getProductElements(db, Number(args[0]), numFlag(args, "--limit")), null, 2));
        break;
      case "product-csr":
        console.log(JSON.stringify(svc.getProductCsr(db, Number(args[0])), null, 2));
        break;
      case "element":
        console.log(JSON.stringify(svc.explainProductElement(db, Number(args[0]), Number(args[1]), Number(args[2])), null, 2));
        break;
      case "product-export":
        console.log(JSON.stringify(svc.exportProduct(db, Number(args[0]), args[1] ?? "triples"), null, 2));
        break;
      default:
        console.error(`未知命令: ${cmd}`);
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    if (cmd !== "serve") db.close();
  }
}

main().catch((e) => {
  if (e instanceof ApiError) {
    console.error(`错误 [${e.code}]: ${e.message}`);
  } else {
    console.error(`内部错误: ${e?.stack ?? e}`);
  }
  process.exitCode = 1;
});
