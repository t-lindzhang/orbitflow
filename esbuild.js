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

/**
 * The ONLY front-end: the React webview app under webview-ui/. Both the
 * sidebar (compact tree) and the editor panel (full tree) are bundled here so
 * a single `npm run build` rebuilds the extension AND its UI together. There
 * is intentionally no second (vanilla) front-end that could drift out of sync.
 */
const webviewBase = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css" },
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const sidebarConfig = {
  ...webviewBase,
  entryPoints: ["webview-ui/src/sidebar-entry.tsx"],
  outfile: "webview-ui/dist/sidebar.js",
};

/** @type {import('esbuild').BuildOptions} */
const fullviewConfig = {
  ...webviewBase,
  entryPoints: ["webview-ui/src/fullview-entry.tsx"],
  outfile: "webview-ui/dist/fullview.js",
};

async function main() {
  const configs = [extensionConfig, sidebarConfig, fullviewConfig];
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log("[esbuild] watching...");
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
