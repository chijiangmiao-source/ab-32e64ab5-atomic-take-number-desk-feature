import { expect, test } from '@playwright/test';

// 场景：提交后服务在“落库后、回包前”崩溃（注入故障返回 503）。
// 页面必须保留待重试操作；刷新页面后仍保留；服务恢复后重试取回唯一镜号。
test('注入故障后保留待重试操作，恢复后重试显示唯一镜号', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('scene-input').fill('E2E-RETRY');
  await page.getByTestId('notes-input').fill('雨夜追车长镜头');
  await page.getByTestId('inject-toggle').check();
  await page.getByTestId('submit-button').click();

  // 注入故障生效：出现待重试操作，并展示 503 错误反馈
  const pendingList = page.getByTestId('pending-list');
  await expect(pendingList).toBeVisible();
  await expect(pendingList).toContainText('E2E-RETRY');
  await expect(pendingList).toContainText('雨夜追车长镜头');
  await expect(pendingList.getByTestId('pending-error')).toContainText('503');

  // 刷新页面：待重试操作仍然保留（本地持久化）
  await page.reload();
  const pendingAfterReload = page.getByTestId('pending-list');
  await expect(pendingAfterReload).toBeVisible();
  await expect(pendingAfterReload).toContainText('雨夜追车长镜头');

  // 服务已恢复：重试取回最初提交的镜号 #1
  await page.getByTestId('retry-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');
  await expect(page.getByTestId('pending-card')).toHaveCount(0);

  // 再领一条新镜号：号码连续为 #2，证明故障没有造成缺号或重号
  await page.getByTestId('notes-input').fill('第二条镜头');
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#2');

  // 场次看板列出两条记录
  const board = page.getByTestId('scene-board');
  await expect(board.getByTestId('scene-op-row')).toHaveCount(2);
  await expect(board).toContainText('雨夜追车长镜头');
  await expect(board).toContainText('第二条镜头');
});

// 场景：同一操作重复提交（双击/重发），服务器幂等返回同一号码。
test('相同操作标识与内容重复提交返回同一镜号', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('scene-input').fill('E2E-IDEMPOTENT');
  await page.getByTestId('notes-input').fill('开场空镜');
  const opId = await page.getByTestId('op-id-input').inputValue();
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');

  // 成功后表单已自动换新标识；手动填回原标识模拟“同一操作原样重发”
  await page.getByTestId('op-id-input').fill(opId);
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');
  await expect(page.getByTestId('replayed-badge')).toBeVisible();

  // 场次看板仍然只有一条记录
  await expect(page.getByTestId('scene-board').getByTestId('scene-op-row')).toHaveCount(1);
});

// 场景：连续领镜。成功领取后直接改备注再领，无需手动换标识，号码连续。
test('成功领取后直接改备注即可领取下一条，号码连续', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('scene-input').fill('E2E-SEQUENCE');
  await page.getByTestId('notes-input').fill('第一条');
  const firstOpId = await page.getByTestId('op-id-input').inputValue();
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');

  // 成功领取后表单已自动换成新标识
  const secondOpId = await page.getByTestId('op-id-input').inputValue();
  expect(secondOpId).not.toBe(firstOpId);

  // 直接改备注再领：拿到 #2，不报标识冲突
  await page.getByTestId('notes-input').fill('第二条');
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#2');
  await expect(page.getByTestId('failed-card')).toHaveCount(0);

  await expect(page.getByTestId('scene-board').getByTestId('scene-op-row')).toHaveCount(2);
});

// 场景（回归）：镜号已落库但首次返回失败（注入故障），此时在主表单改备注
// 再提交——原待重试操作必须保留，新操作另发标识；随后仍能从待重试入口取回原号码。
test('待重试期间改备注再提交不丢失原操作，仍可取回原号码', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('scene-input').fill('E2E-PENDING-GUARD');
  await page.getByTestId('notes-input').fill('原始备注');
  await page.getByTestId('inject-toggle').check();
  await page.getByTestId('submit-button').click();

  // 注入故障：操作进入待重试（其实已落库为 #1）
  await expect(page.getByTestId('pending-card')).toHaveCount(1);

  // 关掉注入，直接在主表单改备注再次提交（表单仍拿着待重试的标识）
  await page.getByTestId('inject-toggle').uncheck();
  await page.getByTestId('notes-input').fill('改动后的备注');
  await page.getByTestId('submit-button').click();

  // 新内容作为新操作成功拿到 #2；原待重试操作仍然保留且内容未被覆盖
  await expect(page.getByTestId('shot-number-value')).toHaveText('#2');
  const pendingCard = page.getByTestId('pending-card');
  await expect(pendingCard).toHaveCount(1);
  await expect(pendingCard).toContainText('原始备注');

  // 从待重试入口重试，取回原号码 #1
  await page.getByTestId('retry-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');
  await expect(page.getByTestId('pending-card')).toHaveCount(0);

  // 场次看板最终为 #1（原始备注）、#2（改动后的备注），无缺号无重号
  const board = page.getByTestId('scene-board');
  await expect(board.getByTestId('scene-op-row')).toHaveCount(2);
  await expect(board).toContainText('原始备注');
  await expect(board).toContainText('改动后的备注');
});
