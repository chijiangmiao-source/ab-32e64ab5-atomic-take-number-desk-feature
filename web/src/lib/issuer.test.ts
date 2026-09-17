import { describe, expect, it, vi } from 'vitest';
import { ConflictError, RequestError, RetryableError, type ShotNumberApi } from './api';
import { Issuer, type KeyValueStorage, type PendingOperation } from './issuer';
import type { IssueRequestBody, IssueResponse, IssuedOperation } from './types';

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function issuedResponse(body: IssueRequestBody, shotNumber: number): IssueResponse {
  return {
    scene_id: body.scene_id,
    client_op_id: body.client_op_id,
    notes: body.notes,
    shot_number: shotNumber,
    created_at: '2026-09-15T00:00:00.000Z',
    notes_revision: 1,
    replayed: false,
  };
}

function existingOperation(body: IssueRequestBody, shotNumber: number): IssuedOperation {
  return {
    scene_id: body.scene_id,
    client_op_id: body.client_op_id,
    notes: body.notes,
    shot_number: shotNumber,
    created_at: '2026-09-15T00:00:00.000Z',
    notes_revision: 1,
  };
}

function idSequence(): () => string {
  let seq = 0;
  return () => `op-${(seq += 1)}`;
}

function mockApi(issue: ShotNumberApi['issue']): ShotNumberApi {
  return {
    issue: vi.fn(issue),
    updateNotes: vi.fn(async () => {
      throw new Error('updateNotes not expected');
    }),
    listNoteRevisions: vi.fn(async () => []),
    listSceneOperations: vi.fn(async () => []),
  };
}

describe('Issuer', () => {
  it('提交成功后记录镜号并清空待重试', async () => {
    const api = mockApi(async (body) => issuedResponse(body, 7));
    const issuer = new Issuer(api, memoryStorage(), idSequence());

    const { opId, outcome } = await issuer.submit({ scene_id: 'A-1', notes: '开场' });

    expect(opId).toBe('op-1');
    expect(outcome.kind).toBe('success');
    expect(api.issue).toHaveBeenCalledTimes(1);
    const snapshot = issuer.getSnapshot();
    expect(snapshot.pending).toHaveLength(0);
    expect(snapshot.issued).toHaveLength(1);
    expect(snapshot.issued[0].shot_number).toBe(7);
  });

  it('可重试失败（503/网络）后保留待重试操作，且持久化到本地存储', async () => {
    const api = mockApi(async () => {
      throw new RetryableError('服务暂时不可用（HTTP 503）', 503);
    });
    const storage = memoryStorage();
    const issuer = new Issuer(api, storage, idSequence());

    await issuer.submit({ scene_id: 'A-1', notes: '雨夜', injectFailureAfterCommit: true });

    const snapshot = issuer.getSnapshot();
    expect(snapshot.issued).toHaveLength(0);
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.pending[0].last_error).toContain('503');
    // 已持久化：刷新页面（新 Issuer 实例）后待重试操作仍在
    const persisted = JSON.parse(
      storage.data.get('shot-number-issuer:pending:v1')!,
    ) as PendingOperation[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0].client_op_id).toBe('op-1');

    const restored = new Issuer(api, storage, idSequence());
    expect(restored.getSnapshot().pending).toHaveLength(1);
    expect(restored.getSnapshot().pending[0].client_op_id).toBe('op-1');
  });

  it('恢复后重试使用完全相同的 client_op_id 与内容，成功后显示唯一镜号', async () => {
    const calls: IssueRequestBody[] = [];
    let down = true;
    const api = mockApi(async (body: IssueRequestBody) => {
      calls.push(body);
      if (down) throw new RetryableError('网络异常');
      return { ...issuedResponse(body, 3), replayed: true };
    });
    const storage = memoryStorage();
    const issuer = new Issuer(api, storage, idSequence());

    await issuer.submit({ scene_id: 'B-2', notes: '追车' });
    expect(issuer.getSnapshot().pending).toHaveLength(1);

    // 模拟服务恢复后重试
    down = false;
    await issuer.retry('op-1');

    expect(calls).toHaveLength(2);
    // 两次调用的幂等键与内容完全一致 —— 服务器据此返回同一个号码
    expect(calls[1].client_op_id).toBe(calls[0].client_op_id);
    expect(calls[1].scene_id).toBe(calls[0].scene_id);
    expect(calls[1].notes).toBe(calls[0].notes);
    // 重试不得再次携带故障注入标记
    expect(calls[0].inject_failure_after_commit).toBeUndefined();
    expect(calls[1].inject_failure_after_commit).toBeUndefined();

    const snapshot = issuer.getSnapshot();
    expect(snapshot.pending).toHaveLength(0);
    expect(snapshot.issued[0].shot_number).toBe(3);
    expect(storage.data.has('shot-number-issuer:pending:v1')).toBe(false);
  });

  it('故障注入标记只在首次尝试时透传', async () => {
    const calls: IssueRequestBody[] = [];
    const api = mockApi(async (body: IssueRequestBody) => {
      calls.push(body);
      if (calls.length === 1) throw new RetryableError('注入故障', 503);
      return issuedResponse(body, 1);
    });
    const issuer = new Issuer(api, memoryStorage(), idSequence());

    await issuer.submit({ scene_id: 'C-3', notes: '', injectFailureAfterCommit: true });
    expect(calls[0].inject_failure_after_commit).toBe(true);

    await issuer.retry('op-1');
    expect(calls[1].inject_failure_after_commit).toBeUndefined();
    expect(issuer.getSnapshot().issued[0].shot_number).toBe(1);
  });

  it('409 冲突转入失败列表并给出反馈，不再重试', async () => {
    const api = mockApi(async (body: IssueRequestBody) => {
      throw new ConflictError('client_op_id 已被占用', existingOperation(body, 5));
    });
    const storage = memoryStorage();
    const issuer = new Issuer(api, storage, idSequence());

    await issuer.submit({ scene_id: 'D-4', notes: '改动后的内容' });

    const snapshot = issuer.getSnapshot();
    expect(snapshot.pending).toHaveLength(0);
    expect(snapshot.issued).toHaveLength(0);
    expect(snapshot.failed).toHaveLength(1);
    expect(snapshot.failed[0].existing_shot_number).toBe(5);
    expect(snapshot.failed[0].reason).toContain('占用');
    // 冲突操作不应留在本地待重试存储里
    expect(storage.data.has('shot-number-issuer:pending:v1')).toBe(false);
  });

  it('待重试操作存在时，同标识不同内容的提交另发新标识且保留原操作', async () => {
    const calls: IssueRequestBody[] = [];
    let firstOpDown = true;
    const api = mockApi(async (body: IssueRequestBody) => {
      calls.push(body);
      if (body.client_op_id === 'op-1') {
        if (firstOpDown) throw new RetryableError('注入故障（HTTP 503）', 503);
        return { ...issuedResponse(body, 1), replayed: true };
      }
      return issuedResponse(body, 2);
    });
    const issuer = new Issuer(api, memoryStorage(), idSequence());

    // 首次提交被注入故障：op-1（原始备注）进入待重试
    const first = await issuer.submit({
      scene_id: 'S-1',
      notes: '原始备注',
      injectFailureAfterCommit: true,
    });
    expect(first.opId).toBe('op-1');
    expect(first.outcome.kind).toBe('pending');

    // 现场在主表单改了备注再次提交（表单仍拿着 op-1）
    firstOpDown = false;
    const second = await issuer.submit({
      scene_id: 'S-1',
      notes: '改动后的备注',
      client_op_id: 'op-1',
    });

    // 新操作另发新标识并成功；原待重试操作原样保留、内容未被覆盖
    expect(second.opId).toBe('op-2');
    expect(second.outcome.kind).toBe('success');
    const snapshot = issuer.getSnapshot();
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.pending[0].client_op_id).toBe('op-1');
    expect(snapshot.pending[0].notes).toBe('原始备注');
    expect(snapshot.issued[0].shot_number).toBe(2);
    // 关键：从未用 op-1 发送过改动后的内容（否则服务器会 409 并丢失原操作）
    expect(
      calls.some((c) => c.client_op_id === 'op-1' && c.notes === '改动后的备注'),
    ).toBe(false);

    // 从待重试入口取回原号码：重试仍使用最初保存的原始载荷
    const retryOutcome = await issuer.retry('op-1');
    expect(retryOutcome.kind).toBe('success');
    const op1Calls = calls.filter((c) => c.client_op_id === 'op-1');
    expect(op1Calls.at(-1)?.notes).toBe('原始备注');
    expect(issuer.getSnapshot().pending).toHaveLength(0);
  });

  it('待重试操作存在时，同标识同内容的提交按重试处理（不新建操作）', async () => {
    const calls: IssueRequestBody[] = [];
    let down = true;
    const api = mockApi(async (body: IssueRequestBody) => {
      calls.push(body);
      if (down) throw new RetryableError('网络异常');
      return { ...issuedResponse(body, 4), replayed: true };
    });
    const issuer = new Issuer(api, memoryStorage(), idSequence());

    await issuer.submit({ scene_id: 'S-9', notes: '同一份内容' });
    expect(issuer.getSnapshot().pending).toHaveLength(1);

    // 服务恢复：用户不改任何内容直接再点一次提交
    down = false;
    const again = await issuer.submit({
      scene_id: 'S-9',
      notes: '同一份内容',
      client_op_id: 'op-1',
    });

    expect(again.opId).toBe('op-1');
    expect(again.outcome.kind).toBe('success');
    expect(calls).toHaveLength(2);
    expect(calls[1].client_op_id).toBe('op-1');
    expect(issuer.getSnapshot().issued[0].shot_number).toBe(4);
    expect(issuer.getSnapshot().pending).toHaveLength(0);
  });

  it('请求不合法（4xx，如备注超长）进入失败列表，不再显示为可重试', async () => {
    const api = mockApi(async () => {
      throw new RequestError('请求被拒绝：备注超过 4000 字上限', 422);
    });
    const storage = memoryStorage();
    const issuer = new Issuer(api, storage, idSequence());

    const { outcome } = await issuer.submit({ scene_id: 'S-2', notes: '长'.repeat(4001) });

    expect(outcome.kind).toBe('rejected');
    const snapshot = issuer.getSnapshot();
    // 不显示为可重试，也不残留在本地待重试存储中
    expect(snapshot.pending).toHaveLength(0);
    expect(storage.data.has('shot-number-issuer:pending:v1')).toBe(false);
    // 进入失败列表并说明原因
    expect(snapshot.failed).toHaveLength(1);
    expect(snapshot.failed[0].reason).toContain('4000');

    // 反复“重试”也不会再发请求
    const retryOutcome = await issuer.retry('op-1');
    expect(retryOutcome.kind).toBe('missing');
    expect(api.issue).toHaveBeenCalledTimes(1);
  });

  it('放弃待重试操作后从存储中移除', async () => {
    const api = mockApi(async () => {
      throw new RetryableError('网络异常');
    });
    const storage = memoryStorage();
    const issuer = new Issuer(api, storage, idSequence());

    await issuer.submit({ scene_id: 'E-5', notes: '' });
    expect(issuer.getSnapshot().pending).toHaveLength(1);

    issuer.discardPending('op-1');
    expect(issuer.getSnapshot().pending).toHaveLength(0);
    expect(storage.data.has('shot-number-issuer:pending:v1')).toBe(false);
  });

  it('同一操作标识重复提交由服务器幂等处理：客户端只发相同载荷', async () => {
    const calls: IssueRequestBody[] = [];
    const api = mockApi(async (body: IssueRequestBody) => {
      calls.push(body);
      return { ...issuedResponse(body, 9), replayed: calls.length > 1 };
    });
    const issuer = new Issuer(api, memoryStorage(), idSequence());

    // 用户拿着同一个 op id 连续提交两次（例如双击）
    await issuer.submit({ scene_id: 'F-6', notes: '同一镜头', client_op_id: 'fixed-op' });
    await issuer.submit({ scene_id: 'F-6', notes: '同一镜头', client_op_id: 'fixed-op' });

    expect(calls).toHaveLength(2);
    expect(calls[0].client_op_id).toBe('fixed-op');
    expect(calls[1].client_op_id).toBe('fixed-op');
    const snapshot = issuer.getSnapshot();
    expect(snapshot.issued).toHaveLength(1);
    expect(snapshot.issued[0].shot_number).toBe(9);
    expect(snapshot.issued[0].replayed).toBe(true);
  });
});
