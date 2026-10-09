#!/usr/bin/env node
// 用法: node extract-changelog.cjs <version> [changelog-path]
// 打印 CHANGELOG 中 "## <version>" 小节(到下一个小节标题或文件尾);
// 找不到该小节时 exit 1(CI 据此回退为放 CHANGELOG 链接)。
const fs = require("fs");

const version = process.argv[2];
const file = process.argv[3] || "CHANGELOG.md";
if (!version) {
  console.error("usage: node extract-changelog.cjs <version> [changelog-path]");
  process.exit(1);
}

const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start === -1) {
  console.error(`CHANGELOG has no "## ${version}" section`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^## /.test(lines[i])) {
    end = i;
    break;
  }
}
process.stdout.write(lines.slice(start, end).join("\n").trimEnd() + "\n");
