import { describe, expect, it } from 'vitest';
import { mergeBoardSnapshot } from './board';
import type { IssuedOperation } from './types';

function op(revision: number, overrides: Partial<IssuedOperation> = {}): IssuedOperation {
  return {
    scene_id: 'S1',
    client_op_id: 'op-1',
    notes: `备注 r${revision}`,
    shot_number: 1,
    created_at: '2026-09-15T00:00:00.000Z',
    notes_revision: revision,
    ...overrides,
  };
}

describe('mergeBoardSnapshot', () => {
  it('本地为空时采用新快照', () => {
    const fetched = [op(0)];
    expect(mergeBoardSnapshot([], fetched)).toEqual(fetched);
  });

  it('相同修订号的轮询快照采用服务端行', () => {
    const result = mergeBoardSnapshot(
      [op(2, { notes: '本终端保存响应写入的 r2 文本' })],
      [op(2, { notes: '服务端轮询回来的 r2 文本' })],
    );
    expect(result[0].notes_revision).toBe(2);
    expect(result[0].notes).toBe('服务端轮询回来的 r2 文本');
  });

  it('较旧的轮询响应不能覆盖新修订（核心不变式）', () => {
    const result = mergeBoardSnapshot(
      [op(3, { notes: '最新 r3 文本（更新的轮询或本终端保存响应）' })],
      [op(1, { notes: '旧 r1 文本（迟到的响应）' })],
    );
    expect(result[0].notes_revision).toBe(3);
    expect(result[0].notes).toBe('最新 r3 文本（更新的轮询或本终端保存响应）');
  });

  it('较新的轮询响应正常推进修订', () => {
    const result = mergeBoardSnapshot(
      [op(1, { notes: 'r1 文本' })],
      [op(2, { notes: 'r2 文本' })],
    );
    expect(result[0].notes_revision).toBe(2);
    expect(result[0].notes).toBe('r2 文本');
  });

  it('不同行按操作标识独立归并，并按镜号排序', () => {
    const previous = [
      op(0, { client_op_id: 'a', shot_number: 1 }),
      op(0, { client_op_id: 'b', shot_number: 2 }),
    ];
    const fetched = [
      op(2, { client_op_id: 'b', shot_number: 2, notes: 'b 的 r2' }),
      op(1, { client_op_id: 'c', shot_number: 3 }),
    ];
    const result = mergeBoardSnapshot(previous, fetched);
    expect(result.map((row) => row.client_op_id)).toEqual(['a', 'b', 'c']);
    expect(result[1].notes_revision).toBe(2);
  });
});
