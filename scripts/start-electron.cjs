const { spawn } = require("node:child_process");
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (process.argv.includes("--dev")) {
  env.VITE_DEV_SERVER_URL = "http://127.0.0.1:5173";
}

const child = spawn(electron, ["."], {
  env,
  stdio: "inherit",
  windowsHide: false
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
