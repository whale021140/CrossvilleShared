import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist/gateway', { recursive: true });
await build({ entryPoints: ['worker/gateway.js'], outfile: 'dist/gateway/index.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
console.log('Built separate read-only gateway. No deployment or D1 binding was configured.');
