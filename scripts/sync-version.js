#!/usr/bin/env node
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const VERSION_FILE = path.join(ROOT_DIR, "VERSION");

async function main() {
  try {
    const versionRaw = (await fs.readFile(VERSION_FILE, "utf8")).trim();
    if (!versionRaw) {
      console.error(`VERSION file is empty`);
      process.exit(1);
    }
    const version = versionRaw;

    // package.json
    const packageJsonPath = path.join(ROOT_DIR, "package.json");
    const pkgText = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(pkgText);
    pkg.version = version;
    await fs.writeFile(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

    // python-wrapper/pyproject.toml
    const pyprojectPath = path.join(ROOT_DIR, "python-wrapper", "pyproject.toml");
    try {
      const pyText = await fs.readFile(pyprojectPath, "utf8");
      const lines = pyText.split(/\r?\n/);
      let inProject = false;
      let updated = false;
      for (let i = 0; i < lines.length; i++) {
        const stripped = lines[i].trim();
        if (/^\[.*\]$/.test(stripped)) {
          inProject = stripped === "[project]";
          continue;
        }
        if (inProject && lines[i].startsWith("version = ")) {
          lines[i] = `version = "${version}"`;
          updated = true;
          break;
        }
      }
      if (!updated) {
        throw new Error("Could not find project.version in python-wrapper/pyproject.toml");
      }
      await fs.writeFile(pyprojectPath, lines.join("\n") + "\n", "utf8");
    } catch (err) {
      // If the file doesn't exist or another error occurs, surface a helpful message
      if (err.code === "ENOENT") {
        // it's okay if python-wrapper is absent in some forks
        console.warn(`Warning: ${pyprojectPath} not found, skipping pyproject update`);
      } else {
        throw err;
      }
    }

    // demo/storybook.html badge
    const storybookPath = path.join(ROOT_DIR, "demo", "storybook.html");
    try {
      let html = await fs.readFile(storybookPath, "utf8");
      const replaced = html.replace(/<span class="badge">v[^<]*<\/span>/, `<span class="badge">v${version}</span>`);
      if (replaced !== html) {
        await fs.writeFile(storybookPath, replaced, "utf8");
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        // optional
      } else {
        throw err;
      }
    }

    // src-tauri/tauri.conf.json
    const tauriConfPath = path.join(ROOT_DIR, "src-tauri", "tauri.conf.json");
    try {
      const tauriText = await fs.readFile(tauriConfPath, "utf8");
      const tauriConf = JSON.parse(tauriText);
      tauriConf.version = version;
      await fs.writeFile(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n", "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    // src-tauri/Cargo.toml — update only the [package] version line
    const cargoTomlPath = path.join(ROOT_DIR, "src-tauri", "Cargo.toml");
    try {
      const cargoText = await fs.readFile(cargoTomlPath, "utf8");
      const lines = cargoText.split(/\r?\n/);
      let inPackage = false;
      let updated = false;
      for (let i = 0; i < lines.length; i++) {
        const stripped = lines[i].trim();
        if (/^\[.*\]$/.test(stripped)) {
          inPackage = stripped === "[package]";
          continue;
        }
        if (inPackage && lines[i].startsWith("version = ")) {
          lines[i] = `version = "${version}"`;
          updated = true;
          break;
        }
      }
      if (updated) {
        await fs.writeFile(cargoTomlPath, lines.join("\n") + "\n", "utf8");
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    console.log(`Synced package versions to ${version}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
