import { expect, test } from '@playwright/test';

// 场记在场次看板行内修订备注的完整验收：
// 1) 行内编辑保存，修订号递增、历史可查，镜号不变；
// 2) 两终端从同一基础修订号编辑不相交区域，后保存方自动合并为一个新修订；
// 3) 重叠编辑返回 409：三方片段就地展示、输入保留，整理后再次保存；
// 4) 保存时网络失败：输入保留，恢复后重试成功。

async function issueShot(page: import('@playwright/test').Page, scene: string, notes: string) {
  await page.getByTestId('scene-input').fill(scene);
  await page.getByTestId('notes-input').fill(notes);
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');
}

test('行内修订备注：修订号递增、历史保留、镜号不变', async ({ page }) => {
  await page.goto('/');
  await issueShot(page, 'E2E-NOTES-EDIT', '发放时的原始备注');

  const row = page.getByTestId('scene-op-row').first();
  await expect(row.getByTestId('notes-revision')).toHaveText('r0');

  // 进入行内编辑
  await row.getByTestId('edit-notes-button').click();
  const draft = row.getByTestId('notes-draft-input');
  await expect(draft).toHaveValue('发放时的原始备注');
  await draft.fill('场记事后补充的拍摄备注');
  await row.getByTestId('save-notes-button').click();

  // 保存成功：文本更新、修订号变为 r1、镜号仍是 #1
  await expect(row.getByTestId('notes-revision')).toHaveText('r1');
  await expect(row).toContainText('场记事后补充的拍摄备注');
  await expect(row.locator('td.num')).toHaveText('#1');

  // 修订历史包含发放备注 r0 与 r1
  await row.getByTestId('history-notes-button').click();
  const history = row.getByTestId('note-history');
  await expect(history.getByTestId('note-revision-item')).toHaveCount(2);
  await expect(history).toContainText('r0');
  await expect(history).toContainText('发放时的原始备注');
  await expect(history).toContainText('场记事后补充的拍摄备注');

  // 轮询之后（3s）文本与修订号不回退
  await page.waitForTimeout(3500);
  await expect(row.getByTestId('notes-revision')).toHaveText('r1');
  await expect(row).toContainText('场记事后补充的拍摄备注');
});

test('两终端不相交编辑自动合并为一个新修订', async ({ page, request }) => {
  await page.goto('/');
  await issueShot(page, 'E2E-NOTES-MERGE', '第一段\n第二段\n第三段\n');

  const row = page.getByTestId('scene-op-row').first();

  // 终端 A（浏览器）从 r0 起改第一段，但先不保存
  await row.getByTestId('edit-notes-button').click();
  const draft = row.getByTestId('notes-draft-input');
  await draft.fill('第一段（终端A改）\n第二段\n第三段\n');

  // 浏览器保存前，终端 B（直接 API）先保存对第三段的修改（同为 r0 基础）
  const listing = await request.get('/api/scenes/E2E-NOTES-MERGE/operations');
  expect(listing.ok()).toBeTruthy();
  const ops = (await listing.json()) as Array<{ client_op_id: string }>;
  expect(ops).toHaveLength(1);

  const bResp = await request.patch(`/api/operations/${ops[0].client_op_id}/notes`, {
    data: {
      client_op_id: ops[0].client_op_id,
      base_revision: 0,
      notes: '第一段\n第二段\n第三段（终端B改）\n',
    },
  });
  expect(bResp.status()).toBe(200);
  expect((await bResp.json()).notes_revision).toBe(1);

  // 浏览器保存后看到自动合并提示并成功（自动合并），只产生一个新修订 r2
  await row.getByTestId('save-notes-button').click();
  await expect(row.getByTestId('notes-revision')).toHaveText('r2');
  await expect(row).toContainText('第一段（终端A改）');
  await expect(row).toContainText('第三段（终端B改）');
  await expect(row.locator('td.num')).toHaveText('#1');

  // 历史只有 r0/r1/r2 三个版本，没有额外修订
  await row.getByTestId('history-notes-button').click();
  await expect(row.getByTestId('note-revision-item')).toHaveCount(3);
});

test('重叠编辑返回 409：展示三方片段、输入保留，整理后再次保存', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await issueShot(page, 'E2E-NOTES-CONFLICT', '开场镜头\n待定备注\n结尾\n');

  const row = page.getByTestId('scene-op-row').first();
  await row.getByTestId('edit-notes-button').click();
  await row
    .getByTestId('notes-draft-input')
    .fill('开场镜头\nA 终端的备注\n结尾\n');

  const listing = await request.get('/api/scenes/E2E-NOTES-CONFLICT/operations');
  const ops = (await listing.json()) as Array<{ client_op_id: string }>;
  const bResp = await request.patch(`/api/operations/${ops[0].client_op_id}/notes`, {
    data: {
      client_op_id: ops[0].client_op_id,
      base_revision: 0,
      notes: '开场镜头\nB 终端的备注\n结尾\n',
    },
  });
  expect(bResp.status()).toBe(200);

  // A 保存：同一区域撞车 → 冲突面板，数据库未动（看板只读行仍是 B 的 r1）
  await row.getByTestId('save-notes-button').click();
  const panel = row.getByTestId('notes-conflict-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('conflict-base')).toContainText('待定备注');
  await expect(panel.getByTestId('conflict-mine')).toContainText('A 终端的备注');
  await expect(panel.getByTestId('conflict-theirs')).toContainText('B 终端的备注');

  // 输入没有丢失
  await expect(row.getByTestId('notes-draft-input')).toHaveValue(
    '开场镜头\nA 终端的备注\n结尾\n',
  );

  // 场记先填入服务端文本，再整理成最终版本并保存
  await row.getByTestId('use-server-notes-button').click();
  await expect(row.getByTestId('notes-draft-input')).toHaveValue(
    '开场镜头\nB 终端的备注\n结尾\n',
  );
  await row
    .getByTestId('notes-draft-input')
    .fill('开场镜头\nA+B 整理后的最终备注\n结尾\n');
  await row.getByTestId('save-notes-button').click();

  // 冲突解决：成为 r2，镜号依旧不变
  await expect(row.getByTestId('notes-revision')).toHaveText('r2');
  await expect(row).toContainText('A+B 整理后的最终备注');
  await expect(row.locator('td.num')).toHaveText('#1');
  await expect(panel).toHaveCount(0);
});

test('保存时网络失败保留输入，恢复后重试成功', async ({ page }) => {
  await page.goto('/');
  await issueShot(page, 'E2E-NOTES-NET', '网络测试原备注');

  const row = page.getByTestId('scene-op-row').first();
  await row.getByTestId('edit-notes-button').click();
  await row.getByTestId('notes-draft-input').fill('断网期间输入的备注');

  // 首次保存：浏览器层面直接掐断 PATCH 请求
  await page.route('**/api/operations/*/notes', (route) => route.abort('failed'));
  await row.getByTestId('save-notes-button').click();

  await expect(row.getByTestId('notes-save-error')).toBeVisible();
  // 草稿原样保留，仍可编辑；基础修订号仍是 r0（没有产生任何修订）
  await expect(row.getByTestId('notes-draft-input')).toHaveValue('断网期间输入的备注');
  await expect(row).toContainText('基础修订号 r0');

  // 网络恢复：解除拦截，用同一份输入再次保存
  await page.unroute('**/api/operations/*/notes');
  await row.getByTestId('save-notes-button').click();
  await expect(row.getByTestId('notes-revision')).toHaveText('r1');
  await expect(row).toContainText('断网期间输入的备注');
});
