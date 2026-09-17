export interface IssuedOperation {
  scene_id: string;
  client_op_id: string;
  notes: string;
  shot_number: number;
  created_at: string;
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
