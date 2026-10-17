import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.ts';
import { faceName, faceIdByName, QQ_FACE_IDS, QQ_FACE_NAMES } from '../src/qface-map.ts';

// 这些函数不依赖 cortico 运行时，可在裸 node --test（非 node_modules 下）独立运行。

test('normalizeConfig 补全缺省值且保持对象引用身份（x-hot 生效前提）', () => {
  const raw = {} as Record<string, unknown>;
  const out = normalizeConfig(raw as never);
  // 同一引用：x-hot 改 loaded config 后能即时反映到 this.config
  assert.equal(out, raw);
  assert.deepEqual(out.groups, []);
  assert.deepEqual(out.privates, []);
  assert.equal(out.sentencesPerMessage, 1);
  assert.equal(out.splitReplyBySentence, true);
  // vision 子对象原地合并，仍为同一引用
  assert.ok(out.vision);
  assert.equal(out.vision.model, 'google/gemini-2.5-flash');
});

test('normalizeConfig 保留原始数组与 numbers', () => {
  const raw = { groups: [111, 222], privates: [333] } as Record<string, unknown>;
  const out = normalizeConfig(raw as never);
  assert.deepEqual(out.groups, [111, 222]);
  assert.deepEqual(out.privates, [333]);
});

test('qface-map 双向映射：faceIdByName 返回 number，未知名为 null', () => {
  assert.equal(faceName(0), '惊讶');
  // faceIdByName 的签名是 number | null，断言必须用数字而非字符串
  assert.equal(faceIdByName('笑哭'), 182);
  assert.equal(faceIdByName('不存在的表情'), null);
});

test('qface-map 往返恒等：faceName(faceIdByName(n)) === n', () => {
  // 正向表与反向表必须同属 NapCat QSid 体系。两表编号体系不一致时（历史实现的
  // 连续序列 vs NapCat 编号），这里的往返会指向毫不相干的表情。
  // 只校验 QQ_FACE_NAMES 覆盖的名字；别名（旺柴→汪汪 等）是语义近似，本就不保证
  // 往返，另在下一条用例里单独断言。
  for (const name of Object.values(QQ_FACE_NAMES)) {
    const id = faceIdByName(name);
    assert.notEqual(id, null, `${name} 应能解析出 face id`);
    assert.equal(faceName(id!), name, `${name} → ${id} → ${faceName(id!)} 往返不自洽`);
  }
});

test('qface-map 别名映射到 NapCat 里最接近的表情', () => {
  const aliases: Record<string, number> = { 旺柴: 277, 狗头: 277, 笑cry: 182, 开心: 4 };
  for (const [name, id] of Object.entries(aliases)) {
    assert.equal(faceIdByName(name), id, `${name} 应别名到 ${id}`);
    assert.equal(faceName(id), QQ_FACE_NAMES[id], `别名目标 ${id} 应是有效 NapCat 表情`);
  }
});

test('qface-map 编号与 NapCat QSid 对齐（抽查）', () => {
  const expected: Record<string, number> = {
    惊讶: 0, 微笑: 14, 玫瑰: 63, 爱心: 66, 太阳: 74, 赞: 76,
    握手: 78, 胜利: 79, 冷汗: 96, 委屈: 106, 生气: 326, 汪汪: 277, 飙泪: 210,
  };
  for (const [name, id] of Object.entries(expected)) {
    assert.equal(faceIdByName(name), id, `${name} 应映射到 NapCat QSid ${id}`);
    assert.equal(faceName(id), name, `QSid ${id} 应渲染为 ${name}`);
  }
});
