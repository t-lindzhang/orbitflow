const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["media/main.ts"],
  bundle: true,
  outfile: "media/main.js",
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: true,
  logLevel: "info",
};

async function main() {
  const ctxExt = await esbuild.context(extensionConfig);
  const ctxWeb = await esbuild.context(webviewConfig);
  if (watch) {
    await Promise.all([ctxExt.watch(), ctxWeb.watch()]);
    console.log("[esbuild] watching...");
  } else {
    await Promise.all([ctxExt.rebuild(), ctxWeb.rebuild()]);
    await Promise.all([ctxExt.dispose(), ctxWeb.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
