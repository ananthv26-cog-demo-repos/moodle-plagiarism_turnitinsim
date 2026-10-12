import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  users, login, createAssignment, acceptEulaIfShown, submitFile, processQueue,
  expectScore, mock, FIXTURES, MOCK_URL,
} from './helpers';

/**
 * With Moodle's anonymous ("blind") marking on, the plugin must not send the
 * student's identity to Turnitin: not in the submission metadata and not in
 * the viewer launch.
 */
test.describe.configure({ mode: 'serial' });

const COURSE_ID = 2;
const run = Date.now().toString(36);
const assignmentName = `Essay 2: Anonymous peer draft (${run})`;
let cmid: number;

test('instructor creates an anonymously marked assignment', async ({ page }) => {
  await login(page, users.dana);
  cmid = await createAssignment(page, { courseId: COURSE_ID, name: assignmentName, anonymous: true });
});

test('Leo submits and the submission reaches Turnitin without his name', async ({ page }) => {
  await login(page, users.leo);
  await acceptEulaIfShown(page, cmid);
  await submitFile(page, cmid, path.join(FIXTURES, 'leo-okafor-essay.txt'));

  const [leo] = await processQueue(['leo-okafor-essay.txt']);
  const owner = leo.metadata.owners?.[0] ?? {};
  expect(owner.given_name ?? '', 'given_name must not be sent under blind marking').toBe('');
  expect(owner.family_name ?? '', 'family_name must not be sent under blind marking').toBe('');
  expect(owner.email ?? '', 'email must not be sent under blind marking').toBe('');
});

test('the grading table hides Leo\'s name but shows his score', async ({ page }) => {
  const leo = (await mock.submissionByTitle('leo-okafor-essay.txt'))!;
  await login(page, users.dana);
  await page.goto(`/mod/assign/view.php?id=${cmid}&action=grading`);
  await expect(page.locator('table.generaltable, table.flexible').first()).not.toContainText('Okafor');
  await expect(page.locator('.turnitinsim_or_score').first()).toHaveText(new RegExp(`^${leo.report!.overall_match_percentage}%?$`));
});

test('the viewer launch is anonymous too', async ({ page, context }) => {
  const leo = (await mock.submissionByTitle('leo-okafor-essay.txt'))!;
  await login(page, users.dana);
  await page.goto(`/mod/assign/view.php?id=${cmid}&action=grading`);
  const score = page.locator('.turnitinsim_or_score').first();

  const [viewer] = await Promise.all([context.waitForEvent('page'), score.click()]);
  await viewer.waitForURL(new RegExp(`^${MOCK_URL}/viewer/`));
  await expect(viewer.getByTestId('viewer-author')).toHaveText('Anonymous student');

  const launch = (await mock.launchesFor(leo.id)).at(-1)!;
  expect(launch.given_name ?? '').toBe('');
  expect(launch.family_name ?? '').toBe('');
});
