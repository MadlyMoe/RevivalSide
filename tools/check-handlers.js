const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const roots = ["packet-handlers", "modules"];

let failed = false;

function checkDirectory(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      checkDirectory(fullPath);
      continue;
    }

    if (
      entry.isFile() &&
      entry.name.endsWith(".js") &&
      path.basename(path.dirname(fullPath)) === "handlers"
    ) {
      const result = spawnSync(process.execPath, ["--check", fullPath], {
        stdio: "inherit",
      });

      if (result.status !== 0) {
        failed = true;
      }
    }
  }
}

for (const root of roots) {
  checkDirectory(root);
}

process.exitCode = failed ? 1 : 0;
