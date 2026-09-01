import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name) => readFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), 'utf8');

// 浏览器按 URL 缓存模块, 所以改了模块却不推入口的版本号, 修复就到不了用户那里 ——
// 服务端一切正常, 测试全绿, 而屏幕上的 bug 还在。这条把两件事绑在一起: app.js 或它
// 直接引入的任何模块变了, 下面的指纹就会变, 逼你连 app.js?v= 一起推。
// 失败时: 推高 index.html 里的 app.js?v=, 再把这里的 fingerprint 换成报错里的实际值。
const APP_VERSION = 89;
const FINGERPRINT = 'b9c817e35545a79a';

test('changing a module the terminal page loads forces its cache-busting version up', () => {
  const html = read('index.html');
  const version = Number(html.match(/\/app\.js\?v=(\d+)/)?.[1]);
  assert.equal(version, APP_VERSION, 'app.js?v= 变了, 请同时更新本测试里的 APP_VERSION 与 FINGERPRINT');

  const app = read('app.js');
  const modules = [...app.matchAll(/from '\.\/([\w-]+\.js)(?:\?v=\d+)?'/g)].map((match) => match[1]).sort();
  assert.ok(modules.length > 3, '没能解析出 app.js 的本地依赖, 说明这条防护已经失效');

  const digest = createHash('sha256');
  digest.update(`v${version}\n${app}`);
  for (const name of modules) digest.update(`\n${name}\n${read(name)}`);
  const fingerprint = digest.digest('hex').slice(0, 16);
  assert.equal(fingerprint, FINGERPRINT,
    `终端页的模块变了。请推高 index.html 的 app.js?v=, 并把 APP_VERSION/FINGERPRINT 更新为 ${version + 1} / <重跑后的值>`);
});
