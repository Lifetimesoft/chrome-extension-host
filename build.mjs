/**
 * build.mjs
 *
 * Bundles the Chrome Extension Host using esbuild.
 * Outputs all scripts to dist/ and copies HTML files alongside them.
 *
 * Usage:
 *   node build.mjs
 */
import { build } from "esbuild"
import { copyFile, mkdir } from "fs/promises"
import { existsSync } from "fs"

const sharedOptions = {
  bundle: true,
  format: "esm",
  target: "es2020",
  sourcemap: true,
  external: [],
}

// Ensure output directories exist
async function ensureDir(dir) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

await ensureDir("dist/popup")
await ensureDir("dist/dashboard")
await ensureDir("dist/logs")

// Bundle background service worker
await build({
  ...sharedOptions,
  entryPoints: ["src/background/index.ts"],
  outfile: "dist/background.js",
})

// Bundle popup script
await build({
  ...sharedOptions,
  entryPoints: ["src/popup/index.ts"],
  outfile: "dist/popup/index.js",
})

// Bundle dashboard script
await build({
  ...sharedOptions,
  entryPoints: ["src/dashboard/index.ts"],
  outfile: "dist/dashboard/index.js",
})

// Bundle logs page script
await build({
  ...sharedOptions,
  entryPoints: ["src/logs/index.ts"],
  outfile: "dist/logs/index.js",
})

// Copy HTML files to dist
await copyFile("src/popup/index.html",    "dist/popup/index.html")
await copyFile("src/dashboard/index.html","dist/dashboard/index.html")
await copyFile("src/logs/index.html",     "dist/logs/index.html")

// Copy manifest.json to dist root — Chrome loads the extension from this directory
await copyFile("manifest.json", "dist/manifest.json")

// Copy icons to dist
await ensureDir("dist/icons")
await copyFile("src/icons/icon16.png",  "dist/icons/icon16.png")
await copyFile("src/icons/icon48.png",  "dist/icons/icon48.png")
await copyFile("src/icons/icon128.png", "dist/icons/icon128.png")

console.log("✅ Extension host build complete → dist/")
