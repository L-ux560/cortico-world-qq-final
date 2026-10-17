// 打包 QQ 扩展的控制台面板 bundle（ESM），供 v5 框架按 /assets/extensions/<pkg>/<version>/console.js 加载。
// 复用 Cortico 仓库里的 esbuild，避免在本扩展里另装依赖。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// 复用 Cortico 仓库里的 esbuild（避免在本扩展里另装依赖）。
// 先按仓内布局（<Cortico>/extensions/packages/<pkg>）找，再回退到本机 Cortico 仓库，
// 这样把本仓单独 clone 出来构建时也能跑。
function loadEsbuild() {
  const candidates = [
    resolve(__dirname, '../../../Cortico/node_modules/esbuild'),
    resolve(__dirname, '../../../../node_modules/esbuild'),
    resolve(__dirname, '../../Cortico/node_modules/esbuild'),
    'D:/testing/Cortico/node_modules/esbuild',
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* 试下一个 */ }
  }
  throw new Error('找不到 esbuild，请先在 Cortico 仓库安装依赖，或在本扩展执行 npm i -D esbuild');
}
const esbuild = loadEsbuild();

const entry = resolve(__dirname, '../src/console/client.ts');
const outfile = resolve(__dirname, '../dist/console.js');

await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: false,
  logLevel: 'info',
});

console.log(`built ${outfile}`);
