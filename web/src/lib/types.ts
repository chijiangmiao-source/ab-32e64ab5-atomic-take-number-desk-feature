export interface IssuedOperation {
  scene_id: string;
  client_op_id: string;
  /** 当前备注（可被场记修订；发放时等于 issue notes）。 */
  notes: string;
  shot_number: number;
  created_at: string;
  /** 当前备注的修订号，从 1（发放备注）开始单调递增。 */
  notes_revision: number;
}

export interface IssueResponse extends IssuedOperation {
  /** true 表示这是一次幂等重放，号码是此前已提交的原始号码 */
  replayed: boolean;
}

export interface IssueRequestBody {
  scene_id: string;
  client_op_id: string;
  notes: string;
  inject_failure_after_commit?: boolean;
}

/** 备注的一个历史版本；revision 1 即发放时的不可变备注。 */
export interface NoteRevision {
  revision: number;
  notes: string;
  revised_at: string;
}

export interface UpdateNotesRequestBody {
  /** 编辑所基于的修订号；落后时服务端执行三方合并。 */
  base_revision: number;
  new_notes: string;
}

export interface UpdateNotesResponse extends IssuedOperation {
  /** true 表示本次保存与另一终端的不相交改动自动合并成了一个新修订。 */
  merged: boolean;
}

/** 409 冲突响应中的三方片段：基础版本 / 服务端当前 / 本地提交。 */
export interface NotesConflictFragment {
  base: string;
  current: string;
  incoming: string;
}

export interface NotesConflictDetail {
  message: string;
  base_revision: number;
  current_revision: number;
  current_notes: string;
  fragments: NotesConflictFragment[];
}
