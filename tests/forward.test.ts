import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardSource, type ForwardSourceIdentity } from '../src/forward-source.ts';

// 纯逻辑，不依赖 cortico 运行时，可在裸 node --test 下独立运行。

function identity(selfId = 1001): ForwardSourceIdentity {
  return {
    selfId,
    groups: new Map([[222, '测试群']]),
    friends: new Map(),
  };
}

test('群转发来源标注（带群名）', () => {
  const nodes = [{ originGroupId: 222 }];
  // 收到转发的是另一个群 333，来源群 222 应标注
  const r = forwardSource(nodes, identity(), 'group', 333);
  assert.ok(r);
  assert.equal(r.label, '群「测试群(222)」');
  assert.deepEqual(r.source, { kind: 'group', id: 222, name: '测试群' });
});

test('来源等于当前会话时抑制（不重复噪声）', () => {
  const nodes = [{ originGroupId: 222 }];
  // 收到转发的就是群 222 本身 → 不标注
  assert.equal(forwardSource(nodes, identity(), 'group', 222), null);
});

test('私聊转发来源标注（对方 QQ）', () => {
  const nodes = [{ originPeerUin: 555 }];
  const r = forwardSource(nodes, identity(), 'group', 999);
  assert.ok(r);
  assert.equal(r.label, '私聊「QQ用户555(555)」');
  assert.deepEqual(r.source, { kind: 'private', id: 555, name: undefined });
});

test('私聊来源等于当前会话时抑制', () => {
  const nodes = [{ originPeerUin: 555 }];
  assert.equal(forwardSource(nodes, identity(), 'private', 555), null);
});

test('混合来源标注多个来源', () => {
  const nodes = [{ originGroupId: 222 }, { originPeerUin: 555 }];
  const r = forwardSource(nodes, identity(), 'group', 999);
  assert.ok(r);
  assert.match(r.label, /多个来源/);
  assert.equal(r.source.kind, 'mixed');
  assert.deepEqual((r.source as any).groups, [222]);
  assert.deepEqual((r.source as any).peers, [555]);
});

test('无来源线索时返回 null', () => {
  assert.equal(forwardSource([{}], identity(), 'group', 1), null);
});
