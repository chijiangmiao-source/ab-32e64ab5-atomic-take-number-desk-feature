import { ConflictError, RequestError, RetryableError, type ShotNumberApi } from './api';
import type { IssueResponse } from './types';

/** 一次尚未确认成功的操作：网络异常 / 5xx 之后保留在此，等待重试。 */
export interface PendingOperation {
  scene_id: string;
  client_op_id: string;
  notes: string;
  attempts: number;
  last_error: string | null;
}

/** 被服务器拒绝（409 冲突）的操作：重试无意义，仅作反馈展示。 */
export interface FailedOperation {
  scene_id: string;
  client_op_id: string;
  notes: string;
  reason: string;
  existing_shot_number: number | null;
}

export interface IssuerSnapshot {
  pending: PendingOperation[];
  failed: FailedOperation[];
  issued: IssueResponse[];
}

/** localStorage 的最小抽象，便于测试注入。 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = 'shot-number-issuer:pending:v1';

export type IdGenerator = () => string;

/** 一次尝试的结果：页面据此决定是否为主表单更换新标识。 */
export type AttemptOutcome =
  | { kind: 'success'; response: IssueResponse }
  | { kind: 'pending' } // 可重试失败：操作仍保留在待重试列表
  | { kind: 'conflict' } // 409：标识被不同内容占用
  | { kind: 'rejected' } // 其它 4xx：请求本身不合法，重试无意义
  | { kind: 'missing' }; // 操作已不存在（可能刚被处理完）

export interface SubmitResult {
  /** 实际使用的 client_op_id（与待重试操作撞标识时会另发新标识） */
  opId: string;
  outcome: AttemptOutcome;
}

export function defaultIdGenerator(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 镜号领取控制器。
 *
 * 关键不变式：一个 client_op_id 对应且仅对应一次"领取下一条镜号"的意图。
 * - 提交前先把操作持久化到本地存储，随后无论页面刷新、断网还是服务崩溃，
 *   待重试操作都不会丢失；
 * - 重试永远使用最初保存的 (scene_id, client_op_id, notes)，因此幂等；
 * - 只有拿到成功响应才会把操作移出待重试列表。
 */
export class Issuer {
  private pendingOps = new Map<string, PendingOperation>();
  private failedOps: FailedOperation[] = [];
  private issuedOps: IssueResponse[] = [];
  private snapshot: IssuerSnapshot;
  private listeners = new Set<() => void>();

  constructor(
    private readonly api: ShotNumberApi,
    private readonly storage: KeyValueStorage,
    private readonly generateId: IdGenerator = defaultIdGenerator,
  ) {
    for (const op of this.loadPersisted()) {
      this.pendingOps.set(op.client_op_id, op);
    }
    this.snapshot = this.computeSnapshot();
  }

  newOperationId(): string {
    return this.generateId();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): IssuerSnapshot => this.snapshot;

  /**
   * 提交一次操作。injectFailureAfterCommit 只在全新操作的首次尝试时透传
   * （开发用），任何形式的重试都不会再携带它。
   *
   * 若传入的 client_op_id 已属于某个待重试操作：
   * - 内容完全一致 → 视为对那次操作的重试，直接重新尝试，不新建、不覆盖；
   * - 内容不同 → 这是一个新操作：另发新标识，原待重试操作原样保留，
   *   仍可从待重试入口取回它的号码。
   */
  async submit(input: {
    scene_id: string;
    notes: string;
    client_op_id?: string;
    injectFailureAfterCommit?: boolean;
  }): Promise<SubmitResult> {
    let clientOpId = input.client_op_id?.trim() || this.generateId();
    const existing = this.pendingOps.get(clientOpId);
    if (existing) {
      if (existing.scene_id === input.scene_id && existing.notes === input.notes) {
        const outcome = await this.attempt(clientOpId, false);
        return { opId: clientOpId, outcome };
      }
      clientOpId = this.generateId();
    }
    const op: PendingOperation = {
      scene_id: input.scene_id,
      notes: input.notes,
      client_op_id: clientOpId,
      attempts: 0,
      last_error: null,
    };
    this.pendingOps.set(clientOpId, op);
    this.persist();
    this.emit();
    const outcome = await this.attempt(clientOpId, input.injectFailureAfterCommit === true);
    return { opId: clientOpId, outcome };
  }

  /** 用最初保存的原始载荷重试一次待重试操作。 */
  async retry(clientOpId: string): Promise<AttemptOutcome> {
    return this.attempt(clientOpId, false);
  }

  /** 放弃一个待重试操作（不再重试，从本地存储移除）。 */
  discardPending(clientOpId: string): void {
    this.pendingOps.delete(clientOpId);
    this.persist();
    this.emit();
  }

  dismissFailed(clientOpId: string): void {
    this.failedOps = this.failedOps.filter((op) => op.client_op_id !== clientOpId);
    this.emit();
  }

  private async attempt(clientOpId: string, injectFailure: boolean): Promise<AttemptOutcome> {
    const op = this.pendingOps.get(clientOpId);
    if (!op) return { kind: 'missing' };
    op.attempts += 1;
    let outcome: AttemptOutcome;
    try {
      const res = await this.api.issue({
        scene_id: op.scene_id,
        client_op_id: op.client_op_id,
        notes: op.notes,
        ...(injectFailure ? { inject_failure_after_commit: true } : {}),
      });
      this.pendingOps.delete(op.client_op_id);
      this.failedOps = this.failedOps.filter((f) => f.client_op_id !== op.client_op_id);
      this.issuedOps = [
        res,
        ...this.issuedOps.filter((i) => i.client_op_id !== op.client_op_id),
      ];
      outcome = { kind: 'success', response: res };
    } catch (err) {
      if (err instanceof ConflictError) {
        // 409：标识已被不同内容占用，重试无意义，转入失败列表反馈给现场。
        this.moveToFailed(op, err.message, err.existing?.shot_number ?? null);
        outcome = { kind: 'conflict' };
      } else if (err instanceof RequestError) {
        // 其它 4xx（如备注超长）：请求本身不合法，重试永远不会成功。
        this.moveToFailed(op, err.message, null);
        outcome = { kind: 'rejected' };
      } else if (err instanceof RetryableError) {
        // 网络异常 / 5xx：操作保留在待重试列表，等待恢复。
        op.last_error = err.message;
        outcome = { kind: 'pending' };
      } else {
        op.last_error = err instanceof Error ? err.message : String(err);
        outcome = { kind: 'pending' };
      }
    }
    this.persist();
    this.emit();
    return outcome;
  }

  /** 把操作移出待重试并记入失败列表（此类失败重试无意义）。 */
  private moveToFailed(
    op: PendingOperation,
    reason: string,
    existingShotNumber: number | null,
  ): void {
    this.pendingOps.delete(op.client_op_id);
    this.failedOps = [
      {
        scene_id: op.scene_id,
        client_op_id: op.client_op_id,
        notes: op.notes,
        reason,
        existing_shot_number: existingShotNumber,
      },
      ...this.failedOps.filter((f) => f.client_op_id !== op.client_op_id),
    ];
  }

  private loadPersisted(): PendingOperation[] {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is PendingOperation =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as PendingOperation).client_op_id === 'string' &&
          typeof (item as PendingOperation).scene_id === 'string' &&
          typeof (item as PendingOperation).notes === 'string',
      );
    } catch {
      return [];
    }
  }

  private persist(): void {
    const ops = [...this.pendingOps.values()];
    if (ops.length === 0) {
      this.storage.removeItem(STORAGE_KEY);
    } else {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(ops));
    }
  }

  private computeSnapshot(): IssuerSnapshot {
    return {
      pending: [...this.pendingOps.values()],
      failed: [...this.failedOps],
      issued: [...this.issuedOps],
    };
  }

  private emit(): void {
    this.snapshot = this.computeSnapshot();
    for (const listener of this.listeners) listener();
  }
}
