import { expect, test, type Page } from '@playwright/test';

// 领取一条镜号并在看板上打开行内编辑器，返回该行的操作标识与编辑器定位器。
async function issueAndEdit(
  page: Page,
  scene: string,
  notes: string,
): Promise<{ row: ReturnType<Page['locator']> }> {
  await page.goto('/');
  await page.getByTestId('scene-input').fill(scene);
  await page.getByTestId('notes-input').fill(notes);
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');

  const row = page.getByTestId('scene-op-row').first();
  await expect(row.getByTestId('notes-revision')).toHaveText('修订 r1');
  await row.getByTestId('notes-edit-button').click();
  await expect(row.getByTestId('notes-draft-input')).toBeVisible();
  return { row };
}

// 场景：场记领取镜号后直接在看板行内修订备注并保存：
// 镜号不变，看板出现新的修订号，历史版本完整。
test('行内修订备注：保存后修订号递增、镜号不变、历史可查', async ({ page }) => {
  const { row } = await issueAndEdit(page, 'E2E-NOTES-EDIT', '原始备注\n第二行');

  await row.getByTestId('notes-draft-input').fill('修订后的备注\n第二行');
  await row.getByTestId('notes-save-button').click();

  // 编辑器关闭，行内显示新文本与 r2
  await expect(row.getByTestId('notes-editor')).toHaveCount(0);
  await expect(row).toContainText('修订后的备注');
  await expect(row.getByTestId('notes-revision')).toHaveText('修订 r2');
  await expect(row).toContainText('#1');

  // 再次编辑并查看历史：r1 是发放备注，r2 是修订
  await row.getByTestId('notes-edit-button').click();
  await row.getByTestId('notes-history-button').click();
  const history = row.getByTestId('notes-history');
  await expect(history).toContainText('r1');
  await expect(history).toContainText('原始备注');
  await expect(history).toContainText('r2');
  await expect(history).toContainText('修订后的备注');
});

// 场景：两台场记终端基于同一修订号编辑不同行：
// 甲先打开编辑器（基于 r1），乙先保存 r2；甲保存时服务端自动三方合并，
// 只产生一个新修订 r3，双方文本都在。
test('两终端不相交编辑自动合并为一个新修订', async ({ page, request }) => {
  const { row } = await issueAndEdit(
    page,
    'E2E-NOTES-MERGE',
    '第一段\n第二段\n第三段\n',
  );

  // 终端甲（本页面）已基于 r1 开始改第一段；此时终端乙改第三段并先保存
  await row.getByTestId('notes-draft-input').fill('第一段（甲改景别）\n第二段\n第三段\n');

  const board = await request.get('/api/scenes/E2E-NOTES-MERGE/operations');
  const ops = await board.json();
  const opId = ops[0].client_op_id;
  const bSave = await request.patch(`/api/operations/${opId}/notes`, {
    data: {
      base_revision: 1,
      new_notes: '第一段\n第二段\n第三段（乙补光说明）\n',
    },
  });
  expect(bSave.status()).toBe(200);
  expect((await bSave.json()).notes_revision).toBe(2);

  // 甲保存：落后基础修订号触发自动合并
  await row.getByTestId('notes-save-button').click();

  await expect(row.getByTestId('notes-merged-notice')).toBeVisible();
  const mergedInput = row.getByTestId('notes-draft-input');
  await expect(mergedInput).toHaveValue('第一段（甲改景别）\n第二段\n第三段（乙补光说明）\n');
  await expect(row).toContainText('基于 r3');

  // 完成合并确认：行内显示 r3，镜号与序列不受影响
  await row.getByTestId('notes-cancel-button').click();
  await expect(row.getByTestId('notes-revision')).toHaveText('修订 r3');
  await expect(row).toContainText('第三段（乙补光说明）');

  // 看板仍只有一条镜号记录；再领一条号码连续为 #2
  await expect(page.getByTestId('scene-op-row')).toHaveCount(1);
  await page.getByTestId('regenerate-op-id').click();
  await page.getByTestId('notes-input').fill('合并后新镜头');
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#2');
});

// 场景：两台终端改了同一区域：甲保存得到含三方片段的 409，输入保留；
// 场记参照服务端文本与本地草稿整理后，基于新修订号再次保存成功。
test('重叠编辑返回冲突片段，整理后再次保存成功', async ({ page, request }) => {
  const { row } = await issueAndEdit(page, 'E2E-NOTES-CONFLICT', '行一\n行二\n行三\n');

  await row.getByTestId('notes-draft-input').fill('行一-甲\n行二\n行三\n');

  const board = await request.get('/api/scenes/E2E-NOTES-CONFLICT/operations');
  const opId = (await board.json())[0].client_op_id;
  const bSave = await request.patch(`/api/operations/${opId}/notes`, {
    data: { base_revision: 1, new_notes: '行一-乙\n行二\n行三\n' },
  });
  expect(bSave.status()).toBe(200);

  await row.getByTestId('notes-save-button').click();

  // 冲突态：三方片段齐全，本地输入保留
  const conflict = row.getByTestId('notes-conflict');
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('行一');
  await expect(conflict).toContainText('行一-乙');
  await expect(conflict).toContainText('行一-甲');
  await expect(row.getByTestId('notes-draft-input')).toHaveValue('行一-甲\n行二\n行三\n');
  await expect(row).toContainText('基于 r2');

  // 场记整理服务端与本地文本（手动合并为定稿）后再次保存
  await row.getByTestId('notes-draft-input').fill('行一-甲乙定稿\n行二\n行三\n');
  await row.getByTestId('notes-save-button').click();

  await expect(row.getByTestId('notes-editor')).toHaveCount(0);
  await expect(row).toContainText('行一-甲乙定稿');
  await expect(row.getByTestId('notes-revision')).toHaveText('修订 r3');

  // 冲突期间数据库停在 r2：历史中 r2 是乙的版本
  await row.getByTestId('notes-edit-button').click();
  await row.getByTestId('notes-history-button').click();
  const history = row.getByTestId('notes-history');
  await expect(history).toContainText('行一-乙');
});

// 场景：保存备注时网络失败：草稿与输入保留、显示错误，恢复后再次保存成功，
// 不会产生重复修订。
test('备注保存网络失败后保留输入，再次保存成功且无重复修订', async ({ page, request }) => {
  const { row } = await issueAndEdit(page, 'E2E-NOTES-RETRY', '网络前的备注');

  await row.getByTestId('notes-draft-input').fill('断网时的修订');

  // 第一次保存：在网络层中止 PATCH
  let aborted = false;
  await page.route('**/api/operations/*/notes', async (route) => {
    if (!aborted) {
      aborted = true;
      return route.abort();
    }
    return route.continue();
  });

  await row.getByTestId('notes-save-button').click();

  // 回到编辑态、错误可见、输入原样保留
  await expect(row.getByTestId('notes-draft-error')).toBeVisible();
  await expect(row.getByTestId('notes-draft-input')).toHaveValue('断网时的修订');
  await expect(row.getByTestId('notes-save-button')).toBeEnabled();

  // 网络恢复后再次保存：成功落为 r2
  await row.getByTestId('notes-save-button').click();
  await expect(row.getByTestId('notes-editor')).toHaveCount(0);
  await expect(row.getByTestId('notes-revision')).toHaveText('修订 r2');
  await expect(row).toContainText('断网时的修订');

  // 服务端只有 r1、r2 两个修订，没有因重试产生重复
  const boardResp = await request.get('/api/scenes/E2E-NOTES-RETRY/operations');
  const opId = (await boardResp.json())[0].client_op_id;
  const historyResp = await request.get(`/api/operations/${opId}/note-revisions`);
  const history = await historyResp.json();
  expect(history.map((h: { revision: number }) => h.revision)).toEqual([1, 2]);
});
