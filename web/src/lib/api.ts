import type {
  IssueRequestBody,
  IssueResponse,
  IssuedOperation,
  NoteRevision,
  NotesConflictDetail,
  UpdateNotesRequestBody,
  UpdateNotesResponse,
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
 * 409：备注修订与服务端的新版本改动重叠，三方合并失败。
 * 数据库保持原样；detail 携带三方片段，场记整理文本后可基于新修订号再保存。
 * 本地草稿必须保留。
 */
export class NotesConflictError extends Error {
  readonly detail: NotesConflictDetail;

  constructor(detail: NotesConflictDetail) {
    super(detail.message);
    this.name = 'NotesConflictError';
    this.detail = detail;
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
  updateNotes(
    clientOpId: string,
    body: UpdateNotesRequestBody,
  ): Promise<UpdateNotesResponse>;
  listNoteRevisions(clientOpId: string): Promise<NoteRevision[]>;
  listSceneOperations(sceneId: string): Promise<IssuedOperation[]>;
}

interface ErrorDetail {
  message?: string;
  existing?: IssuedOperation;
}

async function parseErrorBody(res: Response): Promise<{ detail?: unknown }> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function errorMessage(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object') {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  if (Array.isArray(detail) && detail.length > 0) {
    return detail.map((d: { msg?: string }) => d.msg ?? '').join('；');
  }
  return fallback;
}

function existingFromDetail(detail: unknown): IssuedOperation | null {
  if (detail && typeof detail === 'object') {
    const existing = (detail as { existing?: unknown }).existing;
    if (existing && typeof existing === 'object') return existing as IssuedOperation;
  }
  return null;
}

function conflictDetailFromBody(body: unknown): NotesConflictDetail | null {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as Record<string, unknown>;
  if (
    typeof d.current_revision !== 'number' ||
    typeof d.current_notes !== 'string' ||
    !Array.isArray(d.fragments)
  ) {
    return null;
  }
  const fragments = d.fragments.filter(
    (f): f is NotesConflictDetail['fragments'][number] =>
      !!f &&
      typeof f === 'object' &&
      typeof (f as { base?: unknown }).base === 'string' &&
      typeof (f as { current?: unknown }).current === 'string' &&
      typeof (f as { incoming?: unknown }).incoming === 'string',
  );
  return {
    message: typeof d.message === 'string' ? d.message : '备注修订冲突',
    base_revision:
      typeof d.base_revision === 'number' ? d.base_revision : 0,
    current_revision: d.current_revision,
    current_notes: d.current_notes,
    fragments,
  };
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

      const parsed = await parseErrorBody(res);
      const detail = parsed.detail;
      if (res.status === 409) {
        throw new ConflictError(
          `操作标识冲突：${errorMessage(detail, '同一 client_op_id 不允许携带不同内容')}`,
          existingFromDetail(detail),
        );
      }
      if (res.status >= 500) {
        const base = errorMessage(detail, '服务暂时不可用，操作已保留，可重试');
        throw new RetryableError(`${base}（HTTP ${res.status}）`, res.status);
      }
      throw new RequestError(
        errorMessage(detail, `请求被拒绝（HTTP ${res.status}）`),
        res.status,
      );
    },

    async updateNotes(
      clientOpId: string,
      body: UpdateNotesRequestBody,
    ): Promise<UpdateNotesResponse> {
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
        // 网络失败时请求可能已经提交：保留草稿，原样重试即可安全收敛。
        throw new RetryableError('网络异常：备注未能确认保存，请再次保存');
      }

      if (res.ok) {
        return (await res.json()) as UpdateNotesResponse;
      }

      const parsed = await parseErrorBody(res);
      if (res.status === 409) {
        const conflict = conflictDetailFromBody(parsed);
        if (conflict) throw new NotesConflictError(conflict);
        throw new RequestError(errorMessage(parsed.detail, '备注保存冲突'), 409);
      }
      if (res.status >= 500) {
        const base = errorMessage(parsed.detail, '服务暂时不可用，请再次保存');
        throw new RetryableError(`${base}（HTTP ${res.status}）`, res.status);
      }
      throw new RequestError(
        errorMessage(parsed.detail, `请求被拒绝（HTTP ${res.status}）`),
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

    async listSceneOperations(sceneId: string): Promise<IssuedOperation[]> {
      const res = await fetch(
        `${baseUrl}/api/scenes/${encodeURIComponent(sceneId)}/operations`,
      );
      if (!res.ok) {
        throw new RetryableError(`场次看板加载失败（HTTP ${res.status}）`, res.status);
      }
      return (await res.json()) as IssuedOperation[];
    },
  };
}
