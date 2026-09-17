import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, RequestError, RetryableError, createHttpApi } from './api';

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
