import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
  }),
  // The Kokoro worker runs in its own process. kokoro-js stays external because it loads its
  // voice files relative to its own location inside node_modules.
  esbuild.context({
    ...common,
    entryPoints: ['src/tts/kokoroWorker.ts'],
    outfile: 'dist/kokoroWorker.js',
    external: ['kokoro-js', '@huggingface/transformers'],
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
