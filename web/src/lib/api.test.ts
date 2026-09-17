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
  it('200 返回更新后的操作，merged 标志透传', async () => {
    const payload = {
      scene_id: 'A-1',
      client_op_id: 'op-1',
      notes: '合并文本',
      shot_number: 2,
      created_at: '2026-09-15T00:00:00.000Z',
      notes_revision: 3,
      merged: true,
    };
    const fetchMock = vi.fn(async () => jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.updateNotes('op-1', { base_revision: 1, new_notes: '甲改动' });

    expect(res.notes_revision).toBe(3);
    expect(res.merged).toBe(true);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const [url, init] = calls[0];
    expect(url).toBe('/api/operations/op-1/notes');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      base_revision: 1,
      new_notes: '甲改动',
    });
  });

  it('409 重叠冲突映射为 NotesConflictError，携带当前修订与三方片段', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(409, {
          detail: {
            error: 'notes_revision_conflict',
            message: '备注修订冲突',
            base_revision: 1,
            current_revision: 2,
            current_notes: '服务端文本',
            fragments: [{ base: '旧', current: '新', incoming: '本地' }],
          },
        }),
      ),
    );

    const err = await api
      .updateNotes('op-1', { base_revision: 1, new_notes: '本地文本' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotesConflictError);
    const detail = (err as NotesConflictError).detail;
    expect(detail.current_revision).toBe(2);
    expect(detail.current_notes).toBe('服务端文本');
    expect(detail.fragments[0]).toEqual({ base: '旧', current: '新', incoming: '本地' });
  });

  it('网络异常与 5xx 映射为可重试错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    let err = await api
      .updateNotes('op-1', { base_revision: 1, new_notes: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryableError);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(503, { detail: { message: '服务不可用' } }),
      ),
    );
    err = await api
      .updateNotes('op-1', { base_revision: 1, new_notes: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).status).toBe(503);
  });

  it('404/400 映射为不可重试的 RequestError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(404, { detail: { error: 'not_found', message: '操作标识不存在' } }),
      ),
    );
    let err = await api
      .updateNotes('op-1', { base_revision: 1, new_notes: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).status).toBe(404);
  });
});

describe('createHttpApi.listNoteRevisions', () => {
  it('返回修订历史（r1 即发放备注）', async () => {
    const payload = [
      { revision: 1, notes: '发放备注', revised_at: 't1' },
      { revision: 2, notes: '修订备注', revised_at: 't2' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, payload)));

    const revisions = await api.listNoteRevisions('op-1');
    expect(revisions).toHaveLength(2);
    expect(revisions[0].revision).toBe(1);
    expect(revisions[1].notes).toBe('修订备注');
  });
});
