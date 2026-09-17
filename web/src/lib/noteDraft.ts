import type { ThreeWaySegment } from './types';

/**
 * 行内备注编辑的草稿状态机（纯函数，便于单测）。
 *
 * mode:
 * - idle：未编辑，展示服务端当前备注与修订号；
 * - editing：场记正在编辑；
 * - saving：保存请求在途；
 * - conflict：与其他终端的改动重叠，三方片段就地展示，整理后可再次保存。
 *
 * 关键约定：网络失败与 409 冲突都不会清空 draft —— 场记整理服务端与本地
 * 文本后必须能用同一份输入再次保存。
 */
export type NoteDraftMode = 'idle' | 'editing' | 'saving' | 'conflict';

export interface NoteDraftState {
  mode: NoteDraftMode;
  draft: string;
  /** 本次保存所基于的修订号；冲突解决后推进到服务端当前修订号。 */
  baseRevision: number;
  error: string | null;
  conflictSegments: ThreeWaySegment[];
  /** 冲突时服务端当前文本与修订号（便于“先填入服务端文本再整理”）。 */
  serverNotes: string | null;
  serverRevision: number | null;
}

export interface NoteConflictPayload {
  conflicts: ThreeWaySegment[];
  current: { notes: string; notes_revision: number } | null;
}

export function idleDraft(): NoteDraftState {
  return {
    mode: 'idle',
    draft: '',
    baseRevision: 0,
    error: null,
    conflictSegments: [],
    serverNotes: null,
    serverRevision: null,
  };
}

export function startDraft(
  current: { notes: string; notes_revision: number },
): NoteDraftState {
  return {
    ...idleDraft(),
    mode: 'editing',
    draft: current.notes,
    baseRevision: current.notes_revision,
  };
}

export function changeDraft(state: NoteDraftState, text: string): NoteDraftState {
  if (state.mode === 'idle' || state.mode === 'saving') return state;
  return { ...state, draft: text };
}

export function beginSave(state: NoteDraftState): NoteDraftState {
  if (state.mode !== 'editing' && state.mode !== 'conflict') return state;
  return { ...state, mode: 'saving', error: null };
}

export function saveSucceeded(): NoteDraftState {
  // 看板行由 PATCH 响应刷新；编辑器回到只读展示。
  return idleDraft();
}

export function saveRetryable(state: NoteDraftState, message: string): NoteDraftState {
  if (state.mode !== 'saving') return state;
  // 网络失败/5xx：结果未知，保留输入与原基础修订号，回到可编辑状态直接重试。
  return {
    ...state,
    mode: state.conflictSegments.length > 0 ? 'conflict' : 'editing',
    error: message,
  };
}

export function saveRejected(state: NoteDraftState, message: string): NoteDraftState {
  if (state.mode !== 'saving') return state;
  // 其它 4xx（如备注超长）：请求未被接受，输入保留以便修改后重试。
  return { ...state, mode: 'editing', error: message };
}

export function saveNotesConflict(
  state: NoteDraftState,
  payload: NoteConflictPayload,
  message: string,
): NoteDraftState {
  if (state.mode !== 'saving') return state;
  // 重叠冲突：本地输入原样保留；基础修订号推进到服务端当前版本，
  // 场记对照三方片段整理后再次保存。
  return {
    ...state,
    mode: 'conflict',
    error: message,
    conflictSegments: payload.conflicts,
    serverNotes: payload.current?.notes ?? null,
    serverRevision: payload.current?.notes_revision ?? null,
    baseRevision:
      payload.current?.notes_revision ?? state.baseRevision,
  };
}

export function useServerText(state: NoteDraftState): NoteDraftState {
  if (state.mode !== 'conflict' || state.serverNotes === null) return state;
  return { ...state, draft: state.serverNotes, error: null };
}
