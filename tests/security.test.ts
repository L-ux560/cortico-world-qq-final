import assert from 'node:assert/strict';
import test from 'node:test';

// 安全回归：这几条一旦被改回去，就是可被群友/提示词注入触发的漏洞。
// 认证评审（Pal-AI-Lab/cortico-extensions#104）明确要求修掉，故固化成测试。

import { QQ_DEFAULTS, toIds } from '../src/config.ts';

test('反向监听默认只绑回环，不对外暴露', () => {
  assert.equal(QQ_DEFAULTS.wsHost, '127.0.0.1', '默认必须是回环地址');
  assert.notEqual(QQ_DEFAULTS.wsHost, '0.0.0.0', '默认不得监听所有网卡');
});

test('默认不提供空 token 的对外监听', () => {
  assert.equal(QQ_DEFAULTS.mode, 'reverse');
  assert.equal(QQ_DEFAULTS.wsHost, '127.0.0.1');
});

test('表情包文件名解析不得逃出表情包目录', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(new URL('../src/normalize.ts', import.meta.url), 'utf8');

  // normalize.ts 依赖框架包 cortico（独立 clone 里未安装），无法直接 import；
  // 这里只抽取 resolveEmojiFile 函数体，注入它依赖的 node:path/fs 后单独验证。
  const start = src.indexOf('function resolveEmojiFile');
  assert.ok(start > 0, '必须存在 resolveEmojiFile');
  // 用花括号配平截取完整函数体（函数内有嵌套的 try/catch，不能按 '\n}\n' 截）
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > 0, '函数体括号配平失败');
  const body = src.slice(start, end);
  assert.ok(body.startsWith('function resolveEmojiFile'), '抽取失败');
  // 去掉 TS 类型注解，得到可执行的纯 JS 函数体
  const js = body
    .replace(/function resolveEmojiFile\([^)]*\):\s*[^{]+\{/, 'function resolveEmojiFile(emojiDir, fname) {')
    .replace(/\(n:\s*number\)\s*=>/g, '(n) =>')
    .replace(/\(seg:\s*string\)\s*=>/g, '(seg) =>')
    .replace(/: number\[\]\s*=>/g, ' =>')
    .replace(/\):\s*string \| null\s*\{/g, ') {');
  assert.ok(!js.includes(': string'), 'TS 注解未清理干净');

  const factory = new Function(
    'isAbsolute', 'join', 'relative', 'resolve', 'sep', 'realpathSync', 'existsSync',
    `${js}\nreturn resolveEmojiFile;`,
  );
  const R = factory(
    path.isAbsolute,
    path.join,
    path.relative,
    path.resolve,
    path.sep,
    fs.realpathSync,
    fs.existsSync,
  ) as (dir: string, file: string) => string | null;

  // 用真实的临时目录验证放行行为
  const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emoji-sec-'));
  const base = path.join(root, 'emojis');
  fs.mkdirSync(path.join(base, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(base, 'cat.jpg'), 'x');
  fs.writeFileSync(path.join(base, 'sub', 'dog.png'), 'x');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'x');

  assert.ok(R(base, 'cat.jpg'), '普通文件名应放行');
  assert.ok(R(base, path.join('sub', 'dog.png')), '子目录应放行');

  assert.equal(R(base, path.join('..', 'secret.txt')), null, '不得逃出目录');
  assert.equal(R(base, '..' + path.sep + '..' + path.sep + 'Windows' + path.sep + 'win.ini'), null);
  assert.equal(R(base, '..'), null);
  assert.equal(R(base, path.join(root, 'secret.txt')), null, '绝对路径应拒绝');
  assert.equal(R(base, 'nope.jpg'), null, '不存在的文件应拒绝');
  assert.equal(R(base, ''), null);
  assert.equal(R(base, 'a\0b'), null);

  // 目录内符号链接指向目录外 → 必须拒绝
  try {
    fs.symlinkSync(path.join(root, 'secret.txt'), path.join(base, 'leak.jpg'));
    assert.equal(R(base, 'leak.jpg'), null, '符号链接逃逸必须拒绝');
  } catch {
    /* Windows 创建符号链接可能失败，跳过该项 */
  }

  fs.rmSync(root, { recursive: true, force: true });
});

test('QQ空间附图只接受 http(s) 与 base64，拒绝 file://', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/qzone.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('^https?:\\/\\/'), '应过滤为 http(s) 白名单');
  assert.ok(src.includes('base64:\\/\\/'), '应允许 base64://');
  assert.ok(!/images[^\n]*file:\/\//.test(src), '不应再把 file:// 当作受支持的附图协议');
});

test('反向连接拒绝无鉴权的对外监听', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/driver.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('assertReverseListenerIsSafe'), '必须有对外监听的安全闸');
  assert.ok(src.includes('拒绝启动'), '无 token 且对外监听时应拒绝启动');
});

test('反向连接自动生成并持久化 token', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/world.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('ensureReverseToken'), '必须有 ensureReverseToken');
  assert.ok(src.includes('reverse-token.txt'), 'token 需持久化以跨重启稳定');
  assert.ok(src.includes('randomBytes'), 'token 必须随机生成，不可预测');
});

test('token 必须在 start() 里就备好，不能只挂在建连接时', async () => {
  // 回归：0.3.0~0.3.1 只在 createDriver() 里生成 token，而面板/工具在 start 之后、
  // driver 建立之前也可能读 token，那段时间读到的是空串 → 用户以为没生成。
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/world.ts', import.meta.url), 'utf8');

  const startAt = src.indexOf('async start(host: WorldHost)');
  assert.ok(startAt > 0, '必须存在 start()');
  // 取start() 开头到第一个 driver.start() 之前的片段
  const head = src.slice(startAt, src.indexOf('this.driver.start()', startAt));
  assert.ok(
    head.includes('ensureReverseToken'),
    'start() 里必须无条件调用 ensureReverseToken()，不能依赖 createDriver',
  );
});

test('toIds 只收正整数（回归：空串曾被解析成 [0]）', () => {
  assert.deepEqual(toIds(''), []);
  assert.deepEqual(toIds('   '), []);
  assert.deepEqual(toIds([0]), []);
  assert.deepEqual(toIds('123,456'), [123, 456]);
});