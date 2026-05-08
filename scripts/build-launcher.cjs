const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tempRoot = path.join(root, ".codex_tmp");
const resourceObject = path.join(tempRoot, "launcher.res");
const output = path.join(root, "resources", "launcher", "win-x64", "BGTLauncher.exe");

fs.mkdirSync(tempRoot, { recursive: true });
fs.mkdirSync(path.dirname(output), { recursive: true });

run("windres", [
  path.join(root, "tools", "launcher", "launcher.rc"),
  "-O",
  "coff",
  "-o",
  resourceObject
]);

run("gcc", [
  "-Os",
  "-s",
  "-DNDEBUG",
  "-static",
  "-static-libgcc",
  "-o",
  output,
  path.join(root, "tools", "launcher", "main.c"),
  resourceObject,
  "-lws2_32",
  "-lshell32"
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
