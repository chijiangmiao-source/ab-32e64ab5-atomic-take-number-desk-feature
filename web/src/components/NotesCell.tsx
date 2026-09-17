import { useSyncExternalStore } from 'react';
import type { NotesEditor } from '../lib/notesEditor';
import type { IssuedOperation } from '../lib/types';

const NOTES_MAX_LENGTH = 4000;

/**
 * 场次看板某一行的备注单元格：展示当前备注与修订号，点击就地编辑，
 * 维护 editing / saving / conflict 三种草稿状态。
 */
export function NotesCell({
  operation,
  editor,
  onSaved,
}: {
  operation: IssuedOperation;
  editor: NotesEditor;
  onSaved?: () => void;
}) {
  const drafts = useSyncExternalStore(editor.subscribe, editor.getDrafts);
  const historyMap = useSyncExternalStore(editor.subscribe, editor.getHistory);
  const history = historyMap.get(operation.client_op_id);
  const draft = drafts.get(operation.client_op_id);

  if (!draft) {
    return (
      <div className="notes-cell">
        <span className="notes-text">{operation.notes || '—'}</span>
        <button
          type="button"
          className="ghost notes-edit-button"
          data-testid="notes-edit-button"
          onClick={() => editor.beginEdit(operation)}
        >
          编辑
        </button>
        <span className="revision-badge" data-testid="notes-revision">
          修订 r{operation.notes_revision}
        </span>
      </div>
    );
  }

  const tooLong = draft.text.length > NOTES_MAX_LENGTH;

  return (
    <div className="notes-editor" data-testid="notes-editor" data-status={draft.status}>
      <textarea
        data-testid="notes-draft-input"
        value={draft.text}
        rows={3}
        disabled={draft.status === 'saving'}
        aria-invalid={tooLong}
        onChange={(event) => editor.changeText(operation.client_op_id, event.target.value)}
      />
      <div className="notes-editor-meta">
        <span className={tooLong ? 'error-text' : 'counter'}>
          （{draft.text.length}/{NOTES_MAX_LENGTH}）
        </span>
        <span className="revision-badge">基于 r{draft.base_revision}</span>
        {draft.merged_notice && (
          <span className="merge-notice" data-testid="notes-merged-notice">
            已与另一终端的改动自动合并
          </span>
        )}
      </div>

      {tooLong && (
        <div className="error-text" data-testid="notes-draft-error">
          备注超过 {NOTES_MAX_LENGTH} 字上限，请精简后再保存
        </div>
      )}
      {draft.error && (
        <div className="error-text" data-testid="notes-draft-error">
          {draft.error}
        </div>
      )}

      {draft.status === 'conflict' && draft.conflict && (
        <div className="conflict-box" data-testid="notes-conflict">
          <div className="conflict-title">
            修订冲突：另一终端已保存到 r{draft.conflict.current_revision}，双方改动了同一区域。
            请参照以下三方片段整理后再次保存。
          </div>
          {draft.conflict.fragments.map((fragment, index) => (
            <div className="conflict-fragment" key={index}>
              <div className="conflict-side">
                <span className="conflict-label">基础 r{draft.conflict!.base_revision}</span>
                <pre>{fragment.base || '（空）'}</pre>
              </div>
              <div className="conflict-side current">
                <span className="conflict-label">
                  服务端 r{draft.conflict!.current_revision}
                </span>
                <pre>{fragment.current || '（空）'}</pre>
              </div>
              <div className="conflict-side incoming">
                <span className="conflict-label">本地草稿</span>
                <pre>{fragment.incoming || '（空）'}</pre>
              </div>
            </div>
          ))}
          <div className="conflict-actions">
            <button
              type="button"
              className="ghost"
              data-testid="notes-adopt-server"
              onClick={() => editor.adoptServerText(operation.client_op_id)}
            >
              改用服务端文本再整理
            </button>
          </div>
        </div>
      )}

      <div className="notes-editor-actions">
        <button
          type="button"
          className="primary"
          data-testid="notes-save-button"
          disabled={draft.status === 'saving' || tooLong}
          onClick={async () => {
            await editor.save(operation.client_op_id);
            onSaved?.();
          }}
        >
          {draft.status === 'saving' ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className="ghost"
          data-testid="notes-cancel-button"
          disabled={draft.status === 'saving'}
          onClick={() => {
            editor.cancelEdit(operation.client_op_id);
            onSaved?.();
          }}
        >
          {draft.merged_notice ? '完成' : '取消'}
        </button>
        <button
          type="button"
          className="ghost"
          data-testid="notes-history-button"
          onClick={() => void editor.toggleHistory(operation.client_op_id)}
        >
          {draft.history_open ? '收起历史' : '修订历史'}
        </button>
      </div>

      {draft.history_open && (
        <div className="history-box" data-testid="notes-history">
          {history === undefined ? (
            <span className="hint">历史加载中…</span>
          ) : (
            history
              .slice()
              .reverse()
              .map((revision) => (
                <div className="history-item" key={revision.revision}>
                  <span className="revision-badge">r{revision.revision}</span>
                  <span className="history-time">{revision.revised_at}</span>
                  <pre>{revision.notes || '（空）'}</pre>
                </div>
              ))
          )}
        </div>
      )}
    </div>
  );
}
