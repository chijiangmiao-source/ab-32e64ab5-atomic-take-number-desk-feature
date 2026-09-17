import { useEffect, useRef, useState } from 'react';
import {
  NotesConflictError,
  RequestError,
  RetryableError,
  type ShotNumberApi,
} from './lib/api';
import {
  beginSave,
  changeDraft,
  idleDraft,
  saveNotesConflict,
  saveRejected,
  saveRetryable,
  saveSucceeded,
  startDraft,
  useServerText,
  type NoteDraftState,
} from './lib/noteDraft';
import type { IssuedOperation, NoteRevision } from './lib/types';

const NOTES_MAX_LENGTH = 4000;

interface NotesCellProps {
  op: IssuedOperation;
  api: ShotNumberApi;
  /** 保存（或自动合并）成功后，用服务端返回的最新行更新看板。 */
  onSaved: (op: IssuedOperation, merged: boolean) => void;
}

export function NotesCell({ op, api, onSaved }: NotesCellProps) {
  const [draft, setDraft] = useState<NoteDraftState>(() => idleDraft());
  const [showHistory, setShowHistory] = useState(false);
  const [revisions, setRevisions] = useState<NoteRevision[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // 进入编辑时的修订号：轮询发现服务端已前进时提示“保存将自动合并”。
  const startedAtRevision = useRef(op.notes_revision);

  // 历史面板打开期间服务端修订号前进（轮询/自动合并）：作废已加载列表，
  // 由上面的加载 effect 重新拉取，避免展示缺了最新版本的历史。
  useEffect(() => {
    if (showHistory) setRevisions(null);
    // 仅在修订号变化时触发（showHistory 的首拉由加载 effect 负责）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op.notes_revision]);

  useEffect(() => {
    if (!showHistory || revisions !== null) return;
    let cancelled = false;
    void api
      .listNoteRevisions(op.client_op_id)
      .then((list) => {
        if (!cancelled) {
          setRevisions(list);
          setHistoryError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setHistoryError(err instanceof Error ? err.message : '修订历史加载失败');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showHistory, revisions, api, op.client_op_id]);

  const startEdit = () => {
    startedAtRevision.current = op.notes_revision;
    setDraft(startDraft(op));
  };

  const cancelEdit = () => setDraft(idleDraft());

  const save = async () => {
    if (draft.mode === 'saving' || draft.draft.length > NOTES_MAX_LENGTH) return;
    setDraft(beginSave(draft));
    try {
      const res = await api.updateNotes(op.client_op_id, {
        client_op_id: op.client_op_id,
        base_revision: draft.baseRevision,
        notes: draft.draft,
      });
      onSaved(res, res.merge_status === 'merged');
      setDraft(saveSucceeded());
    } catch (err) {
      if (err instanceof NotesConflictError) {
        // 重叠改动：输入原样保留，基础修订号推进到服务端当前版本，
        // 场记对照三方片段整理后再次保存。
        setDraft((state) =>
          saveNotesConflict(
            state,
            {
              conflicts: err.conflicts,
              current: err.current
                ? {
                    notes: err.current.notes,
                    notes_revision: err.current.notes_revision,
                  }
                : null,
            },
            err.message,
          ),
        );
      } else if (err instanceof RetryableError) {
        // 网络失败 / 5xx：保留输入，可直接再次保存。
        setDraft((state) => saveRetryable(state, err.message));
      } else if (err instanceof RequestError) {
        setDraft((state) => saveRejected(state, err.message));
      } else {
        setDraft((state) =>
          saveRetryable(state, err instanceof Error ? err.message : String(err)),
        );
      }
    }
  };

  const editing = draft.mode !== 'idle';
  const saving = draft.mode === 'saving';
  const inConflict = draft.mode === 'conflict';
  const tooLong = draft.draft.length > NOTES_MAX_LENGTH;
  const serverMovedAhead =
    (draft.mode === 'editing' || inConflict) &&
    op.notes_revision > startedAtRevision.current &&
    op.notes_revision > draft.baseRevision;

  if (!editing) {
    return (
      <div className="notes-view" data-testid={`notes-view-${op.client_op_id}`}>
        <span className="notes-text">{op.notes || '—'}</span>
        <span className="notes-controls">
          <span className="revision-badge" data-testid="notes-revision" title="备注修订号">
            r{op.notes_revision}
          </span>
          <button
            type="button"
            className="ghost link-button"
            data-testid="edit-notes-button"
            onClick={startEdit}
          >
            修订
          </button>
          <button
            type="button"
            className="ghost link-button"
            data-testid="history-notes-button"
            onClick={() => {
              setShowHistory((v) => !v);
            }}
          >
            历史
          </button>
        </span>
        {showHistory && (
          <div className="note-history" data-testid="note-history">
            {historyError && <span className="error-text">{historyError}</span>}
            {revisions === null && !historyError && (
              <span className="hint">修订历史加载中…</span>
            )}
            {revisions?.map((rev) => (
              <div
                className="note-revision"
                data-testid="note-revision-item"
                key={rev.revision}
              >
                <span className="mono">
                  r{rev.revision}
                  {rev.revision === 0 ? '（发放备注）' : ''} · {rev.created_at}
                </span>
                <pre>{rev.notes || '（空）'}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="notes-editor" data-testid={`notes-editor-${op.client_op_id}`}>
      <textarea
        data-testid="notes-draft-input"
        value={draft.draft}
        onChange={(e) => setDraft((state) => changeDraft(state, e.target.value))}
        rows={3}
        disabled={saving}
        aria-invalid={tooLong}
        autoFocus
      />
      <div className="notes-editor-footer">
        <span className={tooLong ? 'error-text' : 'counter'}>
          {draft.draft.length}/{NOTES_MAX_LENGTH} · 基础修订号 r{draft.baseRevision}
        </span>
        <span className="notes-editor-actions">
          <button
            type="button"
            className="primary"
            data-testid="save-notes-button"
            onClick={() => void save()}
            disabled={saving || tooLong}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="ghost"
            data-testid="cancel-notes-button"
            onClick={cancelEdit}
            disabled={saving}
          >
            取消
          </button>
        </span>
      </div>

      {serverMovedAhead && (
        <p className="hint" data-testid="notes-server-ahead">
          其他终端已保存到 r{op.notes_revision}：不相交改动将在保存时自动合并。
        </p>
      )}
      {draft.error && (
        <p className="error-text" data-testid="notes-save-error">
          {draft.error}
        </p>
      )}
      {tooLong && (
        <p className="error-text" data-testid="notes-too-long">
          备注超过 {NOTES_MAX_LENGTH} 字上限，无法保存。
        </p>
      )}

      {inConflict && (
        <div className="notes-conflict" data-testid="notes-conflict-panel">
          <p className="error-text">
            与其他终端的修改在同一区域冲突，数据库未改动。请对照以下三方片段，在上方输入框
            整理出最终文本后再次保存（将以服务端 r{draft.baseRevision} 为基础）。
          </p>
          {draft.conflictSegments.map((segment, idx) => (
            <div className="conflict-segments" key={idx} data-testid="conflict-segment">
              <div>
                <span className="hint">共同基础</span>
                <pre data-testid="conflict-base">{segment.base || '（空）'}</pre>
              </div>
              <div>
                <span className="hint">本终端改动</span>
                <pre data-testid="conflict-mine">{segment.mine || '（空）'}</pre>
              </div>
              <div>
                <span className="hint">服务端当前</span>
                <pre data-testid="conflict-theirs">{segment.theirs || '（空）'}</pre>
              </div>
            </div>
          ))}
          {draft.serverNotes !== null && (
            <button
              type="button"
              className="ghost"
              data-testid="use-server-notes-button"
              onClick={() => setDraft((state) => useServerText(state))}
            >
              先填入服务端文本再整理
            </button>
          )}
        </div>
      )}
    </div>
  );
}
