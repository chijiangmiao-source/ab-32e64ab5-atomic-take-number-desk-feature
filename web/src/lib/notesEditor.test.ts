import { describe, expect, it, vi } from 'vitest';
import { NotesConflictError, RequestError, RetryableError, type ShotNumberApi } from './api';
import { NotesEditor } from './notesEditor';
import type {
  IssuedOperation,
  NoteRevision,
  UpdateNotesResponse,
} from './types';

function operation(overrides: Partial<IssuedOperation> = {}): IssuedOperation {
  return {
    scene_id: 'S-1',
    client_op_id: 'op-1',
    notes: '第一段\n第二段\n第三段\n',
    shot_number: 1,
    created_at: '2026-09-15T00:00:00.000Z',
    notes_revision: 1,
    ...overrides,
  };
}

function savedResponse(notes: string, revision: number, merged = false): UpdateNotesResponse {
  return {
    scene_id: 'S-1',
    client_op_id: 'op-1',
    notes,
    shot_number: 1,
    created_at: '2026-09-15T00:00:00.000Z',
    notes_revision: revision,
    merged,
  };
}

function makeApi(
  updateNotes: ShotNumberApi['updateNotes'] = vi.fn(async () => savedResponse('x', 2)),
  listNoteRevisions: ShotNumberApi['listNoteRevisions'] = vi.fn(async () => []),
): ShotNumberApi {
  return {
    issue: vi.fn(),
    updateNotes: vi.fn(updateNotes),
    listNoteRevisions: vi.fn(listNoteRevisions),
    listSceneOperations: vi.fn(async () => []),
  };
}

describe('NotesEditor', () => {
  it('进入编辑：以当前修订号为基础，文本等于服务端备注', () => {
    const editor = new NotesEditor(makeApi());
    editor.beginEdit(operation());

    const draft = editor.getDrafts().get('op-1')!;
    expect(draft.status).toBe('editing');
    expect(draft.base_revision).toBe(1);
    expect(draft.text).toBe('第一段\n第二段\n第三段\n');
  });

  it('保存成功：携带操作标识与基础修订号，编辑器关闭并推进到新修订', async () => {
    const updateNotes = vi.fn(async () => savedResponse('改后备注', 2));
    const editor = new NotesEditor(makeApi(updateNotes));

    editor.beginEdit(operation());
    editor.changeText('op-1', '改后备注');
    await editor.save('op-1');

    expect(updateNotes).toHaveBeenCalledWith('op-1', {
      base_revision: 1,
      new_notes: '改后备注',
    });
    expect(editor.getDrafts().has('op-1')).toBe(false);
  });

  it('保存中进入 saving 状态，成功后离开', async () => {
    let resolve: (v: UpdateNotesResponse) => void = () => {};
    const pending = new Promise<UpdateNotesResponse>((r) => {
      resolve = r;
    });
    const updateNotes = vi.fn(() => pending);
    const editor = new NotesEditor(makeApi(updateNotes));
    editor.beginEdit(operation());

    const promise = editor.save('op-1');
    expect(editor.getDrafts().get('op-1')!.status).toBe('saving');
    resolve(savedResponse('改后备注', 2));
    await promise;
    expect(editor.getDrafts().has('op-1')).toBe(false);
  });

  it('网络失败：保留输入与基础修订号，回到 editing，可再次保存', async () => {
    const updateNotes = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError('网络异常：备注未能确认保存，请再次保存'))
      .mockResolvedValueOnce(savedResponse('改后备注', 2));
    const editor = new NotesEditor(makeApi(updateNotes));

    editor.beginEdit(operation());
    editor.changeText('op-1', '改后备注');
    await editor.save('op-1');

    let draft = editor.getDrafts().get('op-1')!;
    expect(draft.status).toBe('editing');
    expect(draft.text).toBe('改后备注'); // 输入保留
    expect(draft.base_revision).toBe(1); // 基础修订号不变
    expect(draft.error).toContain('网络');

    await editor.save('op-1');
    expect(updateNotes).toHaveBeenCalledTimes(2);
    // 重试携带完全相同的操作标识 / 基础修订号 / 文本
    expect(updateNotes).toHaveBeenLastCalledWith('op-1', {
      base_revision: 1,
      new_notes: '改后备注',
    });
    expect(editor.getDrafts().has('op-1')).toBe(false);
  });

  it('重叠改动 409：进入 conflict，输入保留，携带三方片段，基础修订前移', async () => {
    const detail = {
      message: '备注修订冲突',
      base_revision: 1,
      current_revision: 2,
      current_notes: '第一段-终端乙\n第二段\n第三段\n',
      fragments: [
        {
          base: '第一段\n',
          current: '第一段-终端乙\n',
          incoming: '第一段-终端甲\n',
        },
      ],
    };
    const updateNotes = vi
      .fn()
      .mockRejectedValueOnce(new NotesConflictError(detail))
      // 场记参照服务端文本整理后再次保存成功
      .mockImplementationOnce(async (_id, body) =>
        savedResponse(body.new_notes, 3),
      );
    const editor = new NotesEditor(makeApi(updateNotes));

    editor.beginEdit(operation());
    editor.changeText('op-1', '第一段-终端甲\n第二段\n第三段\n');
    await editor.save('op-1');

    let draft = editor.getDrafts().get('op-1')!;
    expect(draft.status).toBe('conflict');
    expect(draft.text).toBe('第一段-终端甲\n第二段\n第三段\n'); // 本地输入未被覆盖
    expect(draft.conflict!.fragments).toHaveLength(1);
    expect(draft.server_revision).toBe(2);
    expect(draft.base_revision).toBe(2); // 下一次保存以 r2 为基础

    // 场记整理服务端与本地文本后再次保存
    editor.changeText('op-1', '第一段-合并定稿\n第二段\n第三段\n');
    expect(draft.status).toBe('conflict'); // 改字不改状态，仍点保存
    await editor.save('op-1');
    expect(updateNotes).toHaveBeenLastCalledWith('op-1', {
      base_revision: 2,
      new_notes: '第一段-合并定稿\n第二段\n第三段\n',
    });
    expect(editor.getDrafts().has('op-1')).toBe(false);
  });

  it('冲突后可一键采用服务端文本再整理', async () => {
    const detail = {
      message: '冲突',
      base_revision: 1,
      current_revision: 3,
      current_notes: '服务端最新',
      fragments: [{ base: 'a', current: 'b', incoming: 'c' }],
    };
    const editor = new NotesEditor(
      makeApi(vi.fn(async () => {
        throw new NotesConflictError(detail);
      })),
    );
    editor.beginEdit(operation());
    editor.changeText('op-1', '本地草稿');
    await editor.save('op-1');

    editor.adoptServerText('op-1');
    const draft = editor.getDrafts().get('op-1')!;
    expect(draft.text).toBe('服务端最新');
    expect(draft.base_revision).toBe(3);
    expect(draft.status).toBe('editing');
    expect(draft.conflict).toBeNull();
  });

  it('自动合并成功：merged=true 时保留编辑器并展示提示，文本为合并结果', async () => {
    const updateNotes = vi.fn(async () =>
      savedResponse('第一段-甲改\n第二段\n第三段-乙改\n', 3, true),
    );
    const editor = new NotesEditor(makeApi(updateNotes));

    editor.beginEdit(operation());
    editor.changeText('op-1', '第一段-甲改\n第二段\n第三段\n'); // 基于 r1，乙已改到 r2
    await editor.save('op-1');

    const draft = editor.getDrafts().get('op-1')!;
    expect(draft.status).toBe('editing');
    expect(draft.merged_notice).toBe(true);
    expect(draft.text).toBe('第一段-甲改\n第二段\n第三段-乙改\n');
    expect(draft.base_revision).toBe(3);
  });

  it('较旧的轮询响应不能覆盖更新修订；更新的轮询推进已知版本但不动输入框', () => {
    const editor = new NotesEditor(makeApi());
    editor.beginEdit(operation({ notes_revision: 2, notes: 'r2文本' }));
    editor.changeText('op-1', '本地编辑中');

    // 乱序到达的旧响应（r1）：忽略
    editor.syncFromBoard([operation({ notes_revision: 1, notes: 'r1旧文本' })]);
    let draft = editor.getDrafts().get('op-1')!;
    expect(draft.server_revision).toBe(2);
    expect(draft.server_notes).toBe('r2文本');
    expect(draft.text).toBe('本地编辑中');

    // 新响应（r3）：推进服务端版本，输入框不变
    editor.syncFromBoard([operation({ notes_revision: 3, notes: 'r3文本' })]);
    draft = editor.getDrafts().get('op-1')!;
    expect(draft.server_revision).toBe(3);
    expect(draft.server_notes).toBe('r3文本');
    expect(draft.text).toBe('本地编辑中');

    // 同版本重复轮询不产生更新
    const before = editor.getDrafts();
    editor.syncFromBoard([operation({ notes_revision: 3, notes: 'r3文本' })]);
    expect(editor.getDrafts()).toBe(before);
  });

  it('取消编辑会丢弃草稿；saving 中不可取消', async () => {
    let resolve: (v: UpdateNotesResponse) => void = () => {};
    const pending = new Promise<UpdateNotesResponse>((r) => {
      resolve = r;
    });
    const editor = new NotesEditor(makeApi(vi.fn(() => pending)));
    editor.beginEdit(operation());

    const savePromise = editor.save('op-1');
    expect(editor.getDrafts().get('op-1')!.status).toBe('saving');
    editor.cancelEdit('op-1');
    expect(editor.getDrafts().has('op-1')).toBe(true);

    resolve(savedResponse('x', 2));
    await savePromise;
    expect(editor.getDrafts().has('op-1')).toBe(false);

    editor.beginEdit(operation());
    editor.changeText('op-1', '草稿');
    editor.cancelEdit('op-1');
    expect(editor.getDrafts().has('op-1')).toBe(false);
  });

  it('其它 4xx（如超长）保留输入并提示，不伪装成可重试', async () => {
    const editor = new NotesEditor(
      makeApi(vi.fn(async () => {
        throw new RequestError('请求被拒绝：备注超过 4000 字上限', 422);
      })),
    );
    editor.beginEdit(operation());
    editor.changeText('op-1', '长'.repeat(4001));
    await editor.save('op-1');

    const draft = editor.getDrafts().get('op-1')!;
    expect(draft.status).toBe('editing');
    expect(draft.text).toBe('长'.repeat(4001));
    expect(draft.error).toContain('4000');
  });

  it('修订历史可展开加载并再次收起', async () => {
    const revisions: NoteRevision[] = [
      { revision: 1, notes: '原始', revised_at: 't1' },
      { revision: 2, notes: '修订', revised_at: 't2' },
    ];
    const listNoteRevisions = vi.fn(async () => revisions);
    const editor = new NotesEditor(makeApi(undefined, listNoteRevisions));
    editor.beginEdit(operation());

    await editor.toggleHistory('op-1');
    expect(listNoteRevisions).toHaveBeenCalledWith('op-1');
    expect(editor.getHistory().get('op-1')).toEqual(revisions);
    expect(editor.getDrafts().get('op-1')!.history_open).toBe(true);

    await editor.toggleHistory('op-1');
    expect(editor.getDrafts().get('op-1')!.history_open).toBe(false);
  });
});
