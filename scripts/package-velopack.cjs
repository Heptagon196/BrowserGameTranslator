const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJsonPath = path.join(root, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = packageJson.version;
const packDir = path.join(root, "release", "win-unpacked");
const mainExe = "BrowserGameTranslator.exe";
const mainExePath = path.join(packDir, mainExe);
const outputDir = path.join(root, "release", "velopack");
const iconPath = path.join(root, "resources", "icon", "app.ico");

if (!version) throw new Error("package.json does not contain a version.");
if (!fs.existsSync(mainExePath)) {
  throw new Error(`Missing ${mainExePath}. Run npm run package:dir before npm run package:velopack.`);
}
if (!fs.existsSync(iconPath)) {
  throw new Error(`Missing ${iconPath}. Run npm run build:icon if the icon needs to be regenerated.`);
}

fs.mkdirSync(outputDir, { recursive: true });
removeExistingVersionArtifacts();

run("vpk", [
  "pack",
  "--packId",
  "BrowserGameTranslator",
  "--packTitle",
  "BrowserGameTranslator",
  "--packVersion",
  version,
  "--packDir",
  packDir,
  "--mainExe",
  mainExe,
  "--icon",
  iconPath,
  "--outputDir",
  outputDir
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function removeExistingVersionArtifacts() {
  const releasesPath = path.join(outputDir, "releases.win.json");
  const assetsToDelete = new Set([
    "assets.win.json",
    "RELEASES",
    "BrowserGameTranslator-win-Portable.zip",
    "BrowserGameTranslator-win-Setup.exe"
  ]);
  if (fs.existsSync(releasesPath)) {
    const releaseFeed = JSON.parse(fs.readFileSync(releasesPath, "utf8"));
    const assets = Array.isArray(releaseFeed.Assets) ? releaseFeed.Assets : [];
    const keptAssets = [];
    for (const asset of assets) {
      if (asset && asset.Version === version && typeof asset.FileName === "string") {
        assetsToDelete.add(asset.FileName);
      } else {
        keptAssets.push(asset);
      }
    }
    if (keptAssets.length) {
      fs.writeFileSync(releasesPath, JSON.stringify({ Assets: keptAssets }), "utf8");
    } else {
      assetsToDelete.add("releases.win.json");
    }
  }

  for (const assetName of assetsToDelete) {
    const assetPath = path.resolve(outputDir, assetName);
    if (!assetPath.startsWith(outputDir + path.sep)) {
      throw new Error(`Refusing to delete path outside output directory: ${assetPath}`);
    }
    fs.rmSync(assetPath, { force: true });
  }
}
