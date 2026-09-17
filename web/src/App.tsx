import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { createHttpApi } from './lib/api';
import { mergeBoardSnapshot } from './lib/board';
import { Issuer } from './lib/issuer';
import type { IssuedOperation } from './lib/types';
import { NotesCell } from './NotesCell';

const api = createHttpApi();
const SCENE_STORAGE_KEY = 'shot-number-issuer:scene';
const NOTES_MAX_LENGTH = 4000;

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}

export default function App() {
  const [issuer] = useState(() => new Issuer(api, window.localStorage));
  const snapshot = useSyncExternalStore(issuer.subscribe, issuer.getSnapshot);

  const [sceneId, setSceneId] = useState(
    () => window.localStorage.getItem(SCENE_STORAGE_KEY) ?? '',
  );
  const [notes, setNotes] = useState('');
  const [opId, setOpId] = useState(() => issuer.newOperationId());
  const [injectFailure, setInjectFailure] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [sceneOps, setSceneOps] = useState<IssuedOperation[]>([]);
  const [boardError, setBoardError] = useState<string | null>(null);

  // 轮询请求序号：较早发出的响应（网络抖动下可能晚到）绝不能覆盖更新的数据。
  const pollSeq = useRef(0);

  const applyBoardSnapshot = useCallback((fetched: IssuedOperation[]) => {
    // 按操作标识合并，修订号只升不降：即便旧响应晚到，也不会用旧修订覆盖
    // 新修订（包括本终端刚保存、或较新一次轮询已取回的内容）。
    setSceneOps((previous) => mergeBoardSnapshot(previous, fetched));
  }, []);

  const refreshBoard = useCallback(
    async (scene: string) => {
      const trimmed = scene.trim();
      const seq = ++pollSeq.current;
      if (!trimmed) {
        setSceneOps([]);
        return;
      }
      try {
        const ops = await api.listSceneOperations(trimmed);
        // 过期响应：期间又发起了更新的轮询（或场次已切换），直接丢弃。
        if (seq !== pollSeq.current) return;
        applyBoardSnapshot(ops);
        setBoardError(null);
      } catch {
        if (seq !== pollSeq.current) return;
        setBoardError('场次看板刷新失败：镜号服务不可达');
      }
    },
    [applyBoardSnapshot],
  );

  const handleNotesSaved = useCallback((updated: IssuedOperation, merged: boolean) => {
    // 行内保存成功：立即用服务端返回的最新行更新看板，不等下一次轮询。
    applyBoardSnapshot([updated]);
    if (merged) setBoardError(null);
  }, [applyBoardSnapshot]);

  const issuedCount = snapshot.issued.length;
  useEffect(() => {
    void refreshBoard(sceneId);
    const timer = window.setInterval(() => void refreshBoard(sceneId), 3000);
    return () => window.clearInterval(timer);
  }, [sceneId, issuedCount, refreshBoard]);

  const notesTooLong = notes.length > NOTES_MAX_LENGTH;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const scene = sceneId.trim();
    if (!scene || submitting || notesTooLong) return;
    setSubmitting(true);
    try {
      window.localStorage.setItem(SCENE_STORAGE_KEY, scene);
      const { opId: usedId, outcome } = await issuer.submit({
        scene_id: scene,
        notes,
        client_op_id: opId,
        injectFailureAfterCommit: injectFailure,
      });
      if (outcome.kind === 'success') {
        // 本次操作已完成：直接为下一条镜号备好新标识，
        // 现场改完备注即可再次领取，不必手动换标识。
        setOpId(issuer.newOperationId());
      } else if (usedId !== opId) {
        // 标识与某个待重试操作撞车，控制器已另发新标识：同步到表单。
        setOpId(usedId);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onRetry = async (clientOpId: string) => {
    const outcome = await issuer.retry(clientOpId);
    if (outcome.kind === 'success') {
      // 待重试操作已成功：若主表单还拿着它的标识，一并换新。
      setOpId((current) => (current === clientOpId ? issuer.newOperationId() : current));
    }
  };

  const latest = snapshot.issued[0] ?? null;

  return (
    <div className="page">
      <header className="page-header">
        <h1>镜号发放台</h1>
        <p className="subtitle">
          多台场记终端并发领取镜号：同一操作标识重试永远取回同一号码，号码严格连续、以提交顺序为准。
        </p>
      </header>

      <main className="layout">
        <section className="card">
          <h2>领取下一条镜号</h2>
          <form onSubmit={onSubmit}>
            <label className="field">
              <span>场次</span>
              <input
                data-testid="scene-input"
                value={sceneId}
                onChange={(e) => setSceneId(e.target.value)}
                placeholder="例如：A-12"
                required
              />
            </label>

            <label className="field">
              <span>
                备注
                <span className={notesTooLong ? 'error-text' : 'counter'}>
                  （{notes.length}/{NOTES_MAX_LENGTH}）
                </span>
              </span>
              <textarea
                data-testid="notes-input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="镜头内容备注，可留空"
                rows={2}
                aria-invalid={notesTooLong}
              />
              {notesTooLong && (
                <span className="error-text" data-testid="notes-error">
                  备注超过 {NOTES_MAX_LENGTH} 字上限，请精简后再领取
                </span>
              )}
            </label>

            <label className="field">
              <span>操作标识（client_op_id；成功领取后自动更换，重试同一操作时保持不变）</span>
              <div className="op-id-row">
                <input
                  data-testid="op-id-input"
                  value={opId}
                  onChange={(e) => setOpId(e.target.value)}
                  spellCheck={false}
                  required
                />
                <button
                  type="button"
                  data-testid="regenerate-op-id"
                  onClick={() => setOpId(issuer.newOperationId())}
                  title="开始一次全新操作时生成新标识"
                >
                  新标识
                </button>
              </div>
            </label>

            <fieldset className="dev-options">
              <legend>开发选项</legend>
              <label className="checkbox">
                <input
                  type="checkbox"
                  data-testid="inject-toggle"
                  checked={injectFailure}
                  onChange={(e) => setInjectFailure(e.target.checked)}
                />
                模拟“落库后、回包前”故障（inject_failure_after_commit，仅开发模式生效）
              </label>
            </fieldset>

            <button
              type="submit"
              className="primary"
              data-testid="submit-button"
              disabled={submitting || !sceneId.trim() || !opId.trim() || notesTooLong}
            >
              {submitting ? '提交中…' : '领取下一条镜号'}
            </button>
          </form>

          {latest && (
            <div className="success-banner" data-testid="success-banner">
              <div className="shot-number">
                镜号 <span data-testid="shot-number-value">#{latest.shot_number}</span>
              </div>
              <div className="shot-meta">
                场次 {latest.scene_id} · 操作 {shortId(latest.client_op_id)}
                {latest.replayed && (
                  <span className="badge" data-testid="replayed-badge">
                    幂等重放：号码未变
                  </span>
                )}
              </div>
            </div>
          )}
        </section>

        {snapshot.pending.length > 0 && (
          <section className="card warning" data-testid="pending-list">
            <h2>待重试操作（{snapshot.pending.length}）</h2>
            <p className="hint">
              以下操作已安全保留（含页面刷新）。服务恢复后点击重试，将取回同一个镜号。
            </p>
            {snapshot.pending.map((op) => (
              <div className="op-card" data-testid="pending-card" key={op.client_op_id}>
                <div className="op-card-main">
                  <strong>{op.scene_id}</strong>
                  <span className="notes">{op.notes || '（无备注）'}</span>
                  <span className="meta">
                    操作 {shortId(op.client_op_id)} · 已尝试 {op.attempts} 次
                  </span>
                  {op.last_error && (
                    <span className="error-text" data-testid="pending-error">
                      {op.last_error}
                    </span>
                  )}
                </div>
                <div className="op-card-actions">
                  <button
                    type="button"
                    data-testid="retry-button"
                    onClick={() => void onRetry(op.client_op_id)}
                  >
                    重试
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    data-testid="discard-button"
                    onClick={() => issuer.discardPending(op.client_op_id)}
                  >
                    放弃
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {snapshot.failed.length > 0 && (
          <section className="card danger" data-testid="failed-list">
            <h2>失败操作（重试无效，{snapshot.failed.length}）</h2>
            {snapshot.failed.map((op) => (
              <div className="op-card" data-testid="failed-card" key={op.client_op_id}>
                <div className="op-card-main">
                  <strong>{op.scene_id}</strong>
                  <span className="notes">{op.notes || '（无备注）'}</span>
                  <span className="error-text">{op.reason}</span>
                  {op.existing_shot_number !== null && (
                    <span className="meta">
                      该标识已占用镜号 #{op.existing_shot_number}
                    </span>
                  )}
                </div>
                <div className="op-card-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => issuer.dismissFailed(op.client_op_id)}
                  >
                    知道了
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        <section className="card" data-testid="scene-board">
          <h2>
            场次看板{sceneId.trim() ? `：${sceneId.trim()}` : ''}（已发放 {sceneOps.length} 条）
          </h2>
          {boardError && <p className="error-text">{boardError}</p>}
          {!sceneId.trim() && <p className="hint">填写场次后此处实时显示该场次已发放的镜号。</p>}
          {sceneOps.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>镜号</th>
                  <th>备注（行内可修订）</th>
                  <th>操作标识</th>
                  <th>发放时间 (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {sceneOps.map((op) => (
                  <tr key={op.client_op_id} data-testid="scene-op-row">
                    <td className="num">#{op.shot_number}</td>
                    <td className="notes-cell">
                      <NotesCell op={op} api={api} onSaved={handleNotesSaved} />
                    </td>
                    <td className="mono">{shortId(op.client_op_id)}</td>
                    <td className="mono">{op.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  );
}
