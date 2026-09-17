import { describe, expect, it } from 'vitest';
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
} from './noteDraft';

const current = { notes: '原始备注\n第二行\n', notes_revision: 2 };

describe('noteDraft 状态机', () => {
  it('进入编辑时以服务端当前文本与修订号为草稿基础', () => {
    const state = startDraft(current);
    expect(state.mode).toBe('editing');
    expect(state.draft).toBe(current.notes);
    expect(state.baseRevision).toBe(2);
  });

  it('保存中：编辑/保存中/冲突 状态转换，控件锁定但输入保留', () => {
    let state = startDraft(current);
    state = changeDraft(state, '改后的备注');
    state = beginSave(state);
    expect(state.mode).toBe('saving');
    expect(state.draft).toBe('改后的备注');
    // 保存中不允许再改文本
    expect(changeDraft(state, '别的')).toBe(state);
  });

  it('网络失败后保留输入，回到可编辑状态并可用同一基础修订号重试', () => {
    let state = beginSave(changeDraft(startDraft(current), '我的改动'));
    state = saveRetryable(state, '网络异常');
    expect(state.mode).toBe('editing');
    expect(state.draft).toBe('我的改动');
    expect(state.baseRevision).toBe(2);
    expect(state.error).toContain('网络异常');
  });

  it('409 重叠冲突：输入保留、展示三方片段、基础修订号推进到服务端当前版本', () => {
    let state = beginSave(changeDraft(startDraft(current), '本地的改动'));
    state = saveNotesConflict(
      state,
      {
        conflicts: [{ base: '原始备注\n', mine: '本地的改动\n', theirs: '远端的改动\n' }],
        current: { notes: '远端的改动\n第二行\n', notes_revision: 3 },
      },
      '与其他终端的修改冲突',
    );
    expect(state.mode).toBe('conflict');
    expect(state.draft).toBe('本地的改动'); // 输入没有丢
    expect(state.baseRevision).toBe(3);
    expect(state.serverRevision).toBe(3);
    expect(state.conflictSegments).toHaveLength(1);
    expect(state.conflictSegments[0].theirs).toBe('远端的改动\n');

    // 冲突后再遇网络失败：仍停留在冲突态，输入继续保留
    state = beginSave(state);
    state = saveRetryable(state, 'HTTP 503');
    expect(state.mode).toBe('conflict');
    expect(state.draft).toBe('本地的改动');

    // “先填入服务端文本再整理”
    state = useServerText(state) as ReturnType<typeof useServerText>;
    expect(state.draft).toBe('远端的改动\n第二行\n');

    // 整理后保存成功：编辑器收起
    state = beginSave(state);
    expect(saveSucceeded().mode).toBe('idle');
  });

  it('其它 4xx（如超长）保留输入以便精简后重试', () => {
    let state = beginSave(changeDraft(startDraft(current), '很长'.repeat(3000)));
    state = saveRejected(state, '备注超过 4000 字上限');
    expect(state.mode).toBe('editing');
    expect(state.draft.length).toBeGreaterThan(4000);
  });

  it('取消编辑放弃草稿并回到只读态', () => {
    let state = changeDraft(startDraft(current), '临时改动');
    expect(state.draft).toBe('临时改动');
    state = idleDraft();
    expect(state.mode).toBe('idle');
    expect(state.error).toBeNull();
  });
});
