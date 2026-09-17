import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  NotesConflictError,
  RequestError,
  RetryableError,
  createHttpApi,
} from './api';

const api = createHttpApi();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createHttpApi.issue', () => {
  it('201/200 返回已发放的镜号', async () => {
    const payload = {
      scene_id: 'A-1',
      client_op_id: 'op-1',
      notes: '',
      shot_number: 3,
      created_at: '2026-09-15T00:00:00.000Z',
      replayed: false,
    };
    const fetchMock = vi.fn(async () => jsonResponse(201, payload));
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.issue({ scene_id: 'A-1', client_op_id: 'op-1', notes: '' });

    expect(res.shot_number).toBe(3);
    expect(res.replayed).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/shot-numbers',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('409 映射为 ConflictError 并携带已存在的操作', async () => {
    const existing = {
      scene_id: 'A-1',
      client_op_id: 'op-1',
      notes: '原始内容',
      shot_number: 2,
      created_at: '2026-09-15T00:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(409, {
          detail: {
            error: 'client_op_id_conflict',
            message: 'client_op_id 已被占用',
            existing,
          },
        }),
      ),
    );

    const err = await api
      .issue({ scene_id: 'A-1', client_op_id: 'op-1', notes: '改动' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).existing?.shot_number).toBe(2);
  });

  it('503 映射为可重试错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(503, {
          detail: { error: 'injected_failure_after_commit', message: '注入故障' },
        }),
      ),
    );

    const err = await api
      .issue({ scene_id: 'A-1', client_op_id: 'op-1', notes: '' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).status).toBe(503);
    expect((err as RetryableError).message).toContain('注入故障');
  });

  it('网络异常映射为可重试错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const err = await api
      .issue({ scene_id: 'A-1', client_op_id: 'op-1', notes: '' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RetryableError);
  });

  it('其它 4xx 映射为不可重试的请求错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(422, { detail: [{ msg: 'field required' }] }),
      ),
    );

    const err = await api
      .issue({ scene_id: '', client_op_id: 'op-1', notes: '' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).status).toBe(422);
  });
});

describe('createHttpApi.updateNotes', () => {
  const opId = 'op-9';
  const body = { client_op_id: opId, base_revision: 0, notes: '新备注' };

  it('200 返回更新后的行与合并状态', async () => {
    const payload = {
      scene_id: 'A-1',
      client_op_id: opId,
      notes: '新备注',
      shot_number: 4,
      created_at: '2026-09-15T00:00:00.000Z',
      notes_revision: 1,
      merge_status: 'updated',
    };
    const fetchMock = vi.fn(async () => jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.updateNotes(opId, body);

    expect(res.notes_revision).toBe(1);
    expect(res.merge_status).toBe('updated');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/operations/${opId}/notes`,
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('落后基础号的不相交改动得到 merged 响应（只新增一个修订）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          scene_id: 'A-1',
          client_op_id: opId,
          notes: '合并文本',
          shot_number: 4,
          created_at: '2026-09-15T00:00:00.000Z',
          notes_revision: 2,
          merge_status: 'merged',
        }),
      ),
    );

    const res = await api.updateNotes(opId, body);
    expect(res.merge_status).toBe('merged');
    expect(res.notes_revision).toBe(2);
  });

  it('409 重叠冲突映射为 NotesConflictError 并携带三方片段与当前行', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(409, {
          detail: {
            error: 'notes_conflict',
            message: '备注冲突',
            current: {
              scene_id: 'A-1',
              client_op_id: opId,
              notes: '服务端文本',
              shot_number: 4,
              created_at: '2026-09-15T00:00:00.000Z',
              notes_revision: 1,
            },
            base_revision: 0,
            conflicts: [
              { base: '原行\n', mine: '本地行\n', theirs: '服务端行\n' },
            ],
          },
        }),
      ),
    );

    const err = await api.updateNotes(opId, body).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotesConflictError);
    const conflict = err as NotesConflictError;
    expect(conflict.current?.notes_revision).toBe(1);
    expect(conflict.baseRevision).toBe(0);
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.conflicts[0]).toEqual({
      base: '原行\n',
      mine: '本地行\n',
      theirs: '服务端行\n',
    });
  });

  it('网络异常与 5xx 均映射为可重试错误（输入保留）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const networkErr = await api.updateNotes(opId, body).catch((e: unknown) => e);
    expect(networkErr).toBeInstanceOf(RetryableError);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(500, { detail: { message: '内部错误' } }),
      ),
    );
    const serverErr = await api.updateNotes(opId, body).catch((e: unknown) => e);
    expect(serverErr).toBeInstanceOf(RetryableError);
    expect((serverErr as RetryableError).status).toBe(500);
  });

  it('404 等其它 4xx 映射为 RequestError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(404, { detail: { message: '操作标识不存在' } })),
    );
    const err = await api.updateNotes(opId, body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).status).toBe(404);
  });
});
