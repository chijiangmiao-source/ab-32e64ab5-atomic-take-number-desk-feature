import type { IssuedOperation } from './types';

/**
 * 合并一次看板轮询结果与本地已知行。
 *
 * 不变式：任何行的备注修订号只升不降——较旧的轮询响应（网络抖动下可能晚到）
 * 绝不允许用旧修订覆盖本地已有的新修订（可能来自更新的轮询，或本终端刚保存
 * 成功后由 PATCH 响应写入的行）。镜号、场次、操作标识本身恒定，按标识归并。
 */
export function mergeBoardSnapshot(
  previous: IssuedOperation[],
  fetched: IssuedOperation[],
): IssuedOperation[] {
  const byId = new Map(previous.map((op) => [op.client_op_id, op]));
  for (const op of fetched) {
    const local = byId.get(op.client_op_id);
    if (!local || op.notes_revision >= local.notes_revision) {
      byId.set(op.client_op_id, op);
    }
  }
  return [...byId.values()].sort((a, b) => a.shot_number - b.shot_number);
}
