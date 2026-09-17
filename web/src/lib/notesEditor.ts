import {
  NotesConflictError,
  RequestError,
  RetryableError,
  type ShotNumberApi,
} from './api';
import type { IssuedOperation, NotesConflictDetail } from './types';

/**
 * 行内备注编辑器的草稿状态：
 *
 * - editing  正在编辑（也包括网络失败后——输入保留，可直接再次保存）
 * - saving   保存请求已发出、等待响应
 * - conflict 与服务端新修订改动重叠（409），输入与三方片段都保留
 *
 * 任意时刻每个镜号至多一份草稿；镜号、场次、client_op_id 从不参与编辑。
 */
export type DraftStatus = 'editing' | 'saving' | 'conflict';

export interface NoteDraft {
  client_op_id: string;
  /** 本次编辑实际基于的修订号（冲突人工整理后会前移到冲突响应中的当前修订）。 */
  base_revision: number;
  /** 已知的服务端最新修订号，只增不减（轮询防旧）。 */
  server_revision: number;
  /** 已知的服务端最新文本（冲突时作为人工合并参照，不覆盖输入框）。 */
  server_notes: string;
  /** 文本框内容：网络失败与冲突后原样保留。 */
  text: string;
  status: DraftStatus;
  error: string | null;
  conflict: NotesConflictDetail | null;
  /** 上一次保存是否自动合并了另一终端的改动。 */
  merged_notice: boolean;
  /** 修订历史是否正在展示。 */
  history_open: boolean;
}

export interface HistoryEntry {
  revision: number;
  notes: string;
  revised_at: string;
}

/** 不可变快照：每次状态变化都会产生新的 Map，供 useSyncExternalStore 识别。 */
export type DraftsSnapshot = ReadonlyMap<string, NoteDraft>;
export type HistorySnapshot = ReadonlyMap<string, readonly HistoryEntry[]>;

type Listener = () => void;

/**
 * 场记看板的行内备注控制器。
 *
 * 关键不变式：
 * - 轮询只允许把 server_revision/server_notes 向前推进，较旧的响应被丢弃，
 *   且轮询永远不覆盖场记正在编辑的文本框；
 * - 网络失败与 409 都保留草稿；冲突后场记参照三方片段整理文本，以服务端
 *   当前修订号为新基础再次保存；
 * - 保存成功（含自动合并）才落到一个新修订。
 */
export class NotesEditor {
  private drafts: Map<string, NoteDraft> = new Map();
  private history: Map<string, HistoryEntry[]> = new Map();
  private listeners = new Set<Listener>();

  constructor(private readonly api: ShotNumberApi) {}

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getDrafts = (): DraftsSnapshot => this.drafts;

  getHistory = (): HistorySnapshot => this.history;

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private patchDraft(clientOpId: string, patch: Partial<NoteDraft>): void {
    const current = this.drafts.get(clientOpId);
    if (!current) return;
    const next = new Map(this.drafts);
    next.set(clientOpId, { ...current, ...patch });
    this.drafts = next;
  }

  /**
   * 用看板轮询结果推进已知的服务端版本。单调：较旧的轮询响应（可能乱序到达）
   * 不能覆盖更新的修订；编辑中的文本框不受任何轮询影响。
   */
  syncFromBoard(operations: readonly IssuedOperation[]): void {
    let next: Map<string, NoteDraft> | null = null;
    for (const op of operations) {
      const draft = (next ?? this.drafts).get(op.client_op_id);
      if (!draft) continue;
      // Stale response: never move the known revision backwards.
      if (op.notes_revision < draft.server_revision) continue;
      if (op.notes_revision === draft.server_revision) continue;
      next = next ?? new Map(this.drafts);
      next.set(op.client_op_id, {
        ...draft,
        server_revision: op.notes_revision,
        server_notes: op.notes,
      });
    }
    if (next) {
      this.drafts = next;
      this.emit();
    }
  }

  beginEdit(op: IssuedOperation): void {
    if (this.drafts.has(op.client_op_id)) {
      // A draft already exists (possibly after a failed save): keep it.
      return;
    }
    const next = new Map(this.drafts);
    next.set(op.client_op_id, {
      client_op_id: op.client_op_id,
      base_revision: op.notes_revision,
      server_revision: op.notes_revision,
      server_notes: op.notes,
      text: op.notes,
      status: 'editing',
      error: null,
      conflict: null,
      merged_notice: false,
      history_open: false,
    });
    this.drafts = next;
    this.emit();
  }

  cancelEdit(clientOpId: string): void {
    const draft = this.drafts.get(clientOpId);
    if (!draft || draft.status === 'saving') return;
    const next = new Map(this.drafts);
    next.delete(clientOpId);
    this.drafts = next;
    this.emit();
  }

  changeText(clientOpId: string, text: string): void {
    const draft = this.drafts.get(clientOpId);
    if (!draft || draft.status === 'saving') return;
    this.patchDraft(clientOpId, { text, error: null });
    this.emit();
  }

  /** 冲突整理辅助：用服务端当前文本重填输入框（基础修订同步前移）。 */
  adoptServerText(clientOpId: string): void {
    const draft = this.drafts.get(clientOpId);
    if (!draft || draft.status !== 'conflict' || !draft.conflict) return;
    this.patchDraft(clientOpId, {
      text: draft.conflict.current_notes,
      base_revision: draft.conflict.current_revision,
      status: 'editing',
      conflict: null,
      error: null,
    });
    this.emit();
  }

  async save(clientOpId: string): Promise<void> {
    const draft = this.drafts.get(clientOpId);
    if (!draft || draft.status === 'saving') return;
    const baseRevision = draft.base_revision;
    const text = draft.text;
    const wasHistoryOpen = draft.history_open;
    this.patchDraft(clientOpId, { status: 'saving', error: null });
    this.emit();

    try {
      const res = await this.api.updateNotes(clientOpId, {
        base_revision: baseRevision,
        new_notes: text,
      });
      // Success (direct save or an automatic disjoint merge): the response is
      // the newest revision; older poll responses can no longer overwrite it.
      const next = new Map(this.drafts);
      if (res.merged) {
        // Keep the editor open with a merged notice so the clerk can inspect.
        next.set(clientOpId, {
          client_op_id: clientOpId,
          base_revision: res.notes_revision,
          server_revision: res.notes_revision,
          server_notes: res.notes,
          text: res.notes,
          status: 'editing',
          error: null,
          conflict: null,
          merged_notice: true,
          history_open: wasHistoryOpen,
        });
      } else {
        next.delete(clientOpId);
      }
      this.drafts = next;
      this.emit();
    } catch (err) {
      if (err instanceof NotesConflictError) {
        // Overlapping edits: keep the clerk's text, surface the three-way
        // fragments.  Their next save reconciles against the conflict
        // response's current revision, which becomes the new base.
        this.patchDraft(clientOpId, {
          status: 'conflict',
          conflict: err.detail,
          server_revision: Math.max(draft.server_revision, err.detail.current_revision),
          server_notes: err.detail.current_notes,
          base_revision: err.detail.current_revision,
        });
      } else if (err instanceof RetryableError) {
        // Network/5xx: the request may or may not have landed.  Keep the
        // draft and the original base; saving again converges safely
        // (idempotent save or one more merge).
        this.patchDraft(clientOpId, { status: 'editing', error: err.message });
      } else if (err instanceof RequestError) {
        this.patchDraft(clientOpId, { status: 'editing', error: err.message });
      } else {
        this.patchDraft(clientOpId, {
          status: 'editing',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.emit();
    }
  }

  async toggleHistory(clientOpId: string): Promise<void> {
    const draft = this.drafts.get(clientOpId);
    if (!draft) return;
    if (draft.history_open) {
      this.patchDraft(clientOpId, { history_open: false });
      this.emit();
      return;
    }
    this.patchDraft(clientOpId, { history_open: true, error: null });
    this.emit();
    if (!this.history.has(clientOpId)) {
      try {
        const entries = await this.api.listNoteRevisions(clientOpId);
        const nextHistory = new Map(this.history);
        nextHistory.set(clientOpId, entries);
        this.history = nextHistory;
      } catch (err) {
        this.patchDraft(clientOpId, {
          history_open: false,
          error: err instanceof Error ? err.message : '修订历史加载失败',
        });
      }
    }
    this.emit();
  }
}
