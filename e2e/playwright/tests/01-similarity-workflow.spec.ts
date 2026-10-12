import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  users, login, createAssignment, acceptEulaIfShown, submitFile, processQueue,
  expectScore, mock, FIXTURES, MOCK_URL,
} from './helpers';

/**
 * Instructor sets up an assignment with Turnitin Integrity on, two students
 * submit, the plugin pushes the files to the (mock) Turnitin API, webhooks
 * come back, and the similarity scores + viewer show up in Moodle.
 */
test.describe.configure({ mode: 'serial' });

const COURSE_ID = 2; // ENG 201, created by e2e/cli/seed.php
const run = Date.now().toString(36);
const assignmentName = `Essay 1: The Printing Press (${run})`;
let cmid: number;

test.beforeAll(async () => {
  await mock.reset();
});

test('instructor creates an assignment with Turnitin Integrity enabled', async ({ page }) => {
  await login(page, users.dana);
  cmid = await createAssignment(page, { courseId: COURSE_ID, name: assignmentName });
  await page.goto(`/mod/assign/view.php?id=${cmid}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(assignmentName);
});

test('Priya accepts the EULA and submits an essay that leans on Wikipedia', async ({ page }) => {
  await login(page, users.priya);
  await acceptEulaIfShown(page, cmid);
  await submitFile(page, cmid, path.join(FIXTURES, 'priya-nair-essay.txt'));
  await expect(page.locator('.submissionstatustable')).toContainText('priya-nair-essay.txt');
  // Queued for Turnitin, nothing sent yet.
  await expect(page.locator('.turnitinsim_status, .turnitinsim_links').first()).toBeVisible();
});

test('Marcus submits an original essay', async ({ page }) => {
  await login(page, users.marcus);
  await acceptEulaIfShown(page, cmid);
  await submitFile(page, cmid, path.join(FIXTURES, 'marcus-bell-essay.txt'));
  await expect(page.locator('.submissionstatustable')).toContainText('marcus-bell-essay.txt');
});

test('cron sends both files to Turnitin and webhooks deliver similarity reports', async () => {
  const [priya, marcus] = await processQueue(['priya-nair-essay.txt', 'marcus-bell-essay.txt']);

  // Plugin sent real owner metadata (not anonymous) because blind marking is off.
  expect(priya.metadata.owners?.[0]).toMatchObject({ given_name: 'Priya', family_name: 'Nair' });
  expect(marcus.metadata.owners?.[0]).toMatchObject({ given_name: 'Marcus', family_name: 'Bell' });

  // Deterministic scores from the mock corpus.
  expect(priya.report!.overall_match_percentage).toBeGreaterThanOrEqual(50);
  expect(marcus.report!.overall_match_percentage).toBeLessThanOrEqual(5);

  const events = await mock.webhooksFor([priya.id, marcus.id]);
  expect(events.filter((e) => e.event === 'SUBMISSION_COMPLETE')).toHaveLength(2);
  expect(events.filter((e) => e.event === 'SIMILARITY_COMPLETE')).toHaveLength(2);
  for (const e of events) expect(e.status, `webhook ${e.event} accepted by Moodle`).toBe(200);
});

test('instructor sees each student\'s own similarity score on the grading table', async ({ page }) => {
  const priya = (await mock.submissionByTitle('priya-nair-essay.txt'))!;
  const marcus = (await mock.submissionByTitle('marcus-bell-essay.txt'))!;

  await login(page, users.dana);
  await expectScore(page, cmid, users.priya.name, priya.report!.overall_match_percentage);
  await expectScore(page, cmid, users.marcus.name, marcus.report!.overall_match_percentage);
});

test('instructor opens the similarity viewer and sees the matched sources', async ({ page, context }) => {
  const priya = (await mock.submissionByTitle('priya-nair-essay.txt'))!;
  await login(page, users.dana);
  const score = await expectScore(page, cmid, users.priya.name, priya.report!.overall_match_percentage);

  const [viewer] = await Promise.all([context.waitForEvent('page'), score.click()]);
  await viewer.waitForURL(new RegExp(`^${MOCK_URL}/viewer/`));

  await expect(viewer.getByTestId('viewer-score')).toHaveText(`${priya.report!.overall_match_percentage}%`);
  await expect(viewer.getByTestId('viewer-role')).toHaveText('INSTRUCTOR');
  await expect(viewer.getByTestId('viewer-author')).toHaveText('Priya Nair');
  await expect(viewer.getByTestId('viewer-source').first()).toContainText('Wikipedia');
  await expect(viewer.getByTestId('viewer-paper').locator('mark').first()).toBeVisible();

  const launches = await mock.launchesFor(priya.id);
  expect(launches.at(-1)).toMatchObject({ given_name: 'Priya', family_name: 'Nair', viewer_default_permission_set: 'INSTRUCTOR' });
});

test('Priya can see her own score and open the viewer as a learner', async ({ page, context }) => {
  const priya = (await mock.submissionByTitle('priya-nair-essay.txt'))!;
  await login(page, users.priya);
  await page.goto(`/mod/assign/view.php?id=${cmid}`);
  const score = page.locator('.turnitinsim_or_score');
  await expect(score).toHaveText(new RegExp(`^${priya.report!.overall_match_percentage}%?$`));

  const [viewer] = await Promise.all([context.waitForEvent('page'), score.click()]);
  await viewer.waitForURL(new RegExp(`^${MOCK_URL}/viewer/`));
  await expect(viewer.getByTestId('viewer-role')).toHaveText('LEARNER');
});

test('Priya resubmits a rewritten draft and the score drops', async ({ page }) => {
  const before = (await mock.submissionByTitle('priya-nair-essay.txt'))!;

  await login(page, users.priya);
  await submitFile(page, cmid, path.join(FIXTURES, 'priya-nair-essay-revised.txt'));
  await expect(page.locator('.submissionstatustable')).toContainText('priya-nair-essay-revised.txt');

  const [after] = await processQueue(['priya-nair-essay-revised.txt']);
  expect(after.id).not.toBe(before.id);
  expect(after.report!.overall_match_percentage).toBeLessThan(before.report!.overall_match_percentage);

  await login(page, users.dana);
  await expectScore(page, cmid, users.priya.name, after.report!.overall_match_percentage);
});
