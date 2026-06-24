const esbuild = require('esbuild');

async function build() {
  // Build sidebar entry
  await esbuild.build({
    entryPoints: ['src/sidebar-entry.tsx'],
    bundle: true,
    outfile: 'dist/sidebar.js',
    format: 'iife',
    target: 'es2020',
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
  });

  // Build fullview entry
  await esbuild.build({
    entryPoints: ['src/fullview-entry.tsx'],
    bundle: true,
    outfile: 'dist/fullview.js',
    format: 'iife',
    target: 'es2020',
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
  });

  console.log('Build complete!');
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
