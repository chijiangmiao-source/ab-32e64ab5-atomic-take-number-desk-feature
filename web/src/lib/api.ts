import type {
  IssueRequestBody,
  IssueResponse,
  IssuedOperation,
  NoteRevision,
  NoteUpdateRequestBody,
  NoteUpdateResponse,
  ThreeWaySegment,
} from './types';

/** 409：同一 client_op_id 已被不同内容占用。此类错误重试无意义。 */
export class ConflictError extends Error {
  readonly existing: IssuedOperation | null;

  constructor(message: string, existing: IssuedOperation | null) {
    super(message);
    this.name = 'ConflictError';
    this.existing = existing;
  }
}

/**
 * 409：备注修订与其他终端的改动重叠。携带服务端当前备注、修订号与三方片段，
 * 场记整理文本后用新的基础修订号再次保存即可；输入不会因此丢失。
 */
export class NotesConflictError extends Error {
  readonly current: IssuedOperation | null;
  readonly baseRevision: number | null;
  readonly conflicts: ThreeWaySegment[];
  readonly serverNotes: string | null;

  constructor(
    message: string,
    current: IssuedOperation | null,
    conflicts: ThreeWaySegment[],
    baseRevision: number | null,
    serverNotes: string | null,
  ) {
    super(message);
    this.name = 'NotesConflictError';
    this.current = current;
    this.conflicts = conflicts;
    this.baseRevision = baseRevision;
    this.serverNotes = serverNotes;
  }
}

/** 5xx 或网络异常：操作可能已落库也可能未落库，用相同 client_op_id 重试是安全的。 */
export class RetryableError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'RetryableError';
    this.status = status;
  }
}

/** 其它 4xx：请求本身不合法，重试无意义。 */
export class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

export interface ShotNumberApi {
  issue(body: IssueRequestBody): Promise<IssueResponse>;
  listSceneOperations(sceneId: string): Promise<IssuedOperation[]>;
  updateNotes(
    clientOpId: string,
    body: NoteUpdateRequestBody,
  ): Promise<NoteUpdateResponse>;
  listNoteRevisions(clientOpId: string): Promise<NoteRevision[]>;
}

interface ErrorDetail {
  message?: string;
  existing?: IssuedOperation;
  current?: IssuedOperation;
  conflicts?: ThreeWaySegment[];
  base_revision?: number;
  server_notes?: string;
}

async function parseErrorBody(res: Response): Promise<ErrorDetail> {
  try {
    const body = await res.json();
    const detail = body?.detail;
    if (typeof detail === 'string') return { message: detail };
    if (detail && typeof detail === 'object') {
      return {
        message: detail.message,
        existing: detail.existing ?? null,
        current: detail.current ?? null,
        conflicts: Array.isArray(detail.conflicts) ? detail.conflicts : [],
        base_revision: typeof detail.base_revision === 'number' ? detail.base_revision : null,
        server_notes: typeof detail.server_notes === 'string' ? detail.server_notes : null,
      };
    }
    if (Array.isArray(detail) && detail.length > 0) {
      return { message: detail.map((d: { msg?: string }) => d.msg ?? '').join('；') };
    }
    return {};
  } catch {
    return {};
  }
}

export function createHttpApi(baseUrl = ''): ShotNumberApi {
  return {
    async issue(body: IssueRequestBody): Promise<IssueResponse> {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/shot-numbers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        throw new RetryableError('网络异常：无法连接镜号服务，操作已保留，可稍后重试');
      }

      if (res.ok) {
        return (await res.json()) as IssueResponse;
      }

      const detail = await parseErrorBody(res);
      if (res.status === 409) {
        throw new ConflictError(
          `操作标识冲突：${detail.message ?? '同一 client_op_id 不允许携带不同内容'}`,
          detail.existing ?? null,
        );
      }
      if (res.status >= 500) {
        const base = detail.message ?? '服务暂时不可用，操作已保留，可重试';
        throw new RetryableError(`${base}（HTTP ${res.status}）`, res.status);
      }
      throw new RequestError(
        detail.message
          ? `请求被拒绝：${detail.message}`
          : `请求被拒绝（HTTP ${res.status}）`,
        res.status,
      );
    },

    async listSceneOperations(sceneId: string): Promise<IssuedOperation[]> {
      const res = await fetch(
        `${baseUrl}/api/scenes/${encodeURIComponent(sceneId)}/operations`,
      );
      if (!res.ok) {
        throw new RetryableError(`场次看板刷新失败（HTTP ${res.status}）`, res.status);
      }
      return (await res.json()) as IssuedOperation[];
    },

    async updateNotes(
      clientOpId: string,
      body: NoteUpdateRequestBody,
    ): Promise<NoteUpdateResponse> {
      let res: Response;
      try {
        res = await fetch(
          `${baseUrl}/api/operations/${encodeURIComponent(clientOpId)}/notes`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
      } catch {
        throw new RetryableError('网络异常：备注未能保存，输入已保留，可稍后重试');
      }

      if (res.ok) {
        return (await res.json()) as NoteUpdateResponse;
      }

      const detail = await parseErrorBody(res);
      if (res.status === 409) {
        throw new NotesConflictError(
          detail.message ?? '备注与其他终端的修改冲突，请整理后再保存',
          detail.current ?? null,
          detail.conflicts ?? [],
          detail.base_revision ?? null,
          detail.server_notes ?? null,
        );
      }
      if (res.status >= 500) {
        const base = detail.message ?? '服务暂时不可用，备注未保存，可重试';
        throw new RetryableError(`${base}（HTTP ${res.status}）`, res.status);
      }
      throw new RequestError(
        detail.message
          ? `请求被拒绝：${detail.message}`
          : `请求被拒绝（HTTP ${res.status}）`,
        res.status,
      );
    },

    async listNoteRevisions(clientOpId: string): Promise<NoteRevision[]> {
      const res = await fetch(
        `${baseUrl}/api/operations/${encodeURIComponent(clientOpId)}/note-revisions`,
      );
      if (!res.ok) {
        throw new RetryableError(`修订历史加载失败（HTTP ${res.status}）`, res.status);
      }
      return (await res.json()) as NoteRevision[];
    },
  };
}
