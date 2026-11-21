#!/usr/bin/env node
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_THEME_CSS } from "./src/theme.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APPS = [
  { entry: "pr-dossier.js", out: "pr-dossier.html", title: "AStack PR Dossier" },
  { entry: "arch-audit.js", out: "arch-audit.html", title: "AStack Architecture Audit" },
  { entry: "tla-viewer.js", out: "tla-viewer.html", title: "AStack TLA+ Viewer" },
];

const MAX_BYTES = 1024 * 1024;

export async function buildAllUi() {
  const srcDir = path.join(__dirname, "src");
  const outDir = path.join(__dirname, "ui");
  fs.mkdirSync(outDir, { recursive: true });

  const built = [];
  for (const app of APPS) {
    const entryPath = path.join(srcDir, app.entry);
    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: "iife",
      minify: true,
      write: false,
      platform: "browser",
      target: ["es2022"],
    });

    const jsCode = result.outputFiles[0].text.replace(/<\/script>/gi, "<\\/script>");
    const html = [
      "<!doctype html>",
      `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
      `<title>${app.title}</title>`,
      `<style>${BASE_THEME_CSS}</style>`,
      `</head><body><div id="app"></div><script>${jsCode}</script></body></html>`,
      "",
    ].join("\n");

    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_BYTES) {
      throw new Error(`${app.out} bundle size ${bytes} exceeds ${MAX_BYTES}-byte limit`);
    }
    const outPath = path.join(outDir, app.out);
    fs.writeFileSync(outPath, html, "utf8");
    built.push({ out: app.out, bytes });
  }
  return built;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = await buildAllUi();
  for (const item of built) {
    process.stdout.write(`[build-ui] ${item.out}: ${item.bytes} bytes\n`);
  }
}
