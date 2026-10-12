import { expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MOCK_URL = process.env.MOCK_URL || 'http://localhost:8090';
const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURES = path.join(E2E_DIR, 'playwright/fixtures');

export const users = {
  admin: { username: 'admin', password: 'Admin-123!', name: 'Admin User' },
  dana: { username: 'dana.whitfield', password: 'Demo-Pass1!', name: 'Dana Whitfield' },
  priya: { username: 'priya.nair', password: 'Demo-Pass1!', name: 'Priya Nair' },
  marcus: { username: 'marcus.bell', password: 'Demo-Pass1!', name: 'Marcus Bell' },
  leo: { username: 'leo.okafor', password: 'Demo-Pass1!', name: 'Leo Okafor' },
};
export type User = (typeof users)[keyof typeof users];

export async function login(page: Page, user: User) {
  await page.context().clearCookies();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto('/login/index.php');
    await page.fill('#username', user.username);
    await page.fill('#password', user.password);
    await page.click('#loginbtn');
    const menu = page.locator('.usermenu, #usermenu, [data-region="user-menu"]').first();
    const failed = page.locator('.alert-danger:has-text("Invalid login")');
    await expect(menu.or(failed)).toBeVisible();
    if (await menu.isVisible()) return;
  }
  throw new Error(`Could not log in as ${user.username}`);
}

/** Runs a Moodle scheduled task inside the moodle container, the way cron would. */
export function runTask(classname: string) {
  const cmd = `docker compose exec -T -u www-data moodle php admin/cli/scheduled_task.php --execute='${classname}'`;
  return execSync(cmd, { cwd: E2E_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export const tasks = {
  sendSubmissions: () => runTask('\\plagiarism_turnitinsim\\task\\send_submissions'),
  getReports: () => runTask('\\plagiarism_turnitinsim\\task\\get_reports'),
};

/** Mock Turnitin API introspection. */
export const mock = {
  async state() {
    const r = await fetch(`${MOCK_URL}/__mock/state`);
    return (await r.json()) as MockState;
  },
  async reset() {
    await fetch(`${MOCK_URL}/__mock/reset`, { method: 'POST' });
  },
  /** Most recently created mock submission with this title. */
  async submissionByTitle(title: string) {
    const s = await this.state();
    return Object.values(s.submissions)
      .filter((x) => x.title === title)
      .sort((a, b) => a.created_time.localeCompare(b.created_time))
      .at(-1);
  },
  async webhooksFor(submissionIds: string[]) {
    const s = await this.state();
    return s.requests.filter((r) => r.kind === 'webhook' && submissionIds.includes(r.payload?.id ?? r.payload?.submission_id ?? ''));
  },
  async launchesFor(submissionId: string) {
    const s = await this.state();
    return Object.values(s.launches).filter((l) => l.submission_id === submissionId);
  },
};

export interface MockSubmission {
  id: string;
  title: string;
  status: string;
  owner: string;
  created_time: string;
  metadata: { owners?: Array<{ id: string; given_name?: string; family_name?: string; email?: string }> };
  report?: { overall_match_percentage: number; top_matches: Array<{ name: string; percentage: number }> };
}
export interface MockLaunch {
  submission_id: string;
  given_name?: string;
  family_name?: string;
  viewer_default_permission_set?: string;
}
export interface MockState {
  submissions: Record<string, MockSubmission>;
  launches: Record<string, MockLaunch>;
  requests: Array<{
    at: string; kind: string; method?: string; path?: string; event?: string; status?: number;
    payload?: { id?: string; submission_id?: string };
  }>;
}

/** Instructor creates an assignment with Turnitin on. Returns the course module id. */
export async function createAssignment(
  page: Page,
  opts: { courseId: number; name: string; anonymous?: boolean },
): Promise<number> {
  await page.goto(`/course/modedit.php?add=assign&course=${opts.courseId}&section=0&return=0`);
  await page.fill('#id_name', opts.name);

  // Make sure every collapsed section is open so the Turnitin block is visible.
  const expandAll = page.locator('a.collapseexpand[aria-expanded="false"]');
  if (await expandAll.count()) await expandAll.click();

  const tiiEnabled = page.locator('#id_turnitinenabled');
  await expect(tiiEnabled).toBeVisible();
  if (!(await tiiEnabled.isChecked())) await tiiEnabled.check();

  if (opts.anonymous) {
    await page.selectOption('#id_blindmarking', '1');
  }

  await page.click('#id_submitbutton2'); // Save and return to course
  await expect(page).toHaveURL(/course\/view\.php/);
  const link = page.locator(`.activity .activityname a:has-text("${opts.name}"), a.aalink:has-text("${opts.name}")`).first();
  const href = await link.getAttribute('href');
  const m = href?.match(/id=(\d+)/);
  if (!m) throw new Error(`Could not find assignment link for ${opts.name}`);
  return Number(m[1]);
}

/** Student accepts the Turnitin EULA on the edit-submission page, if prompted. */
export async function acceptEulaIfShown(page: Page, cmid: number) {
  await page.goto(`/mod/assign/view.php?id=${cmid}&action=editsubmission`);
  const accept = page.locator('#turnitinsim_eula_accept');
  if (await accept.isVisible().catch(() => false)) {
    await expect(page.locator('a:has-text("Turnitin End User Licence Agreement")')).toHaveAttribute('href', /eula/);
    await accept.click();
    await expect(page.locator('.turnitinsim_eulacontainer')).toContainText(/Thank you for accepting/i);
    return true;
  }
  return false;
}

/** Student uploads a file through the Moodle file picker and saves the submission. */
export async function submitFile(page: Page, cmid: number, filePath: string) {
  await acceptEulaIfShown(page, cmid);
  const filemanager = page.locator('.filemanager').first();
  await expect(filemanager.locator('.fp-btn-add').first()).toBeVisible();

  // Replace any existing file so a resubmission is a real resubmission.
  await expect(filemanager).toHaveClass(/fm-loaded/);
  await expect(filemanager).not.toHaveClass(/fm-updating/);
  const existing = filemanager.locator('.fp-content .fp-file:visible');
  while ((await existing.count()) > 0) {
    const n = await existing.count();
    await existing.first().click();
    const del = page.locator('.fp-select:visible .fp-file-delete, .moodle-dialogue:visible .fp-file-delete').first();
    await del.click();
    await page.locator('.moodle-dialogue:visible, .modal:visible').last().getByRole('button', { name: /^(OK|Yes|Delete)$/ }).click();
    await expect(existing).toHaveCount(n - 1);
    await expect(filemanager).not.toHaveClass(/fm-updating/);
  }

  // Drag-and-drop the file onto the file manager, the way a student would.
  const dataTransfer = await page.evaluateHandle(
    ({ name, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: 'text/plain' }));
      return dt;
    },
    { name: path.basename(filePath), content: fs.readFileSync(filePath, 'utf8') },
  );
  const dropzone = filemanager.locator('.filemanager-container').first();
  await dropzone.dispatchEvent('dragenter', { dataTransfer });
  await dropzone.dispatchEvent('dragover', { dataTransfer });
  await dropzone.dispatchEvent('drop', { dataTransfer });
  await expect(filemanager.locator('.fp-content .fp-file:visible')).toHaveCount(1);
  await expect(filemanager).not.toHaveClass(/fm-updating/);

  await page.click('#id_submitbutton');
  await expect(page).toHaveURL(new RegExp(`mod/assign/view\\.php\\?id=${cmid}`));
}

/** Pushes queued submissions to the (mock) Turnitin API and waits for the webhooks to land. */
export async function processQueue(expectedTitles: string[], timeoutMs = 30_000) {
  tasks.sendSubmissions();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await mock.state();
    const subs = expectedTitles.map((t) =>
      Object.values(s.submissions).filter((x) => x.title === t).sort((a, b) => a.created_time.localeCompare(b.created_time)).at(-1));
    if (subs.every((x) => x && x.report)) return subs as MockSubmission[];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for similarity reports for ${expectedTitles.join(', ')}`);
}

/** The score cell for a given student on the instructor's grading table. */
export function gradingRowFor(page: Page, studentName: string) {
  return page.locator('table.generaltable tr, table.flexible tr').filter({ hasText: studentName }).first();
}

export async function expectScore(page: Page, cmid: number, studentName: string, pct: number) {
  await page.goto(`/mod/assign/view.php?id=${cmid}&action=grading`);
  const row = gradingRowFor(page, studentName);
  await expect(row).toBeVisible();
  const score = row.locator('.turnitinsim_or_score');
  await expect(score).toHaveText(new RegExp(`^\\s*${pct}%?\\s*$`));
  return score;
}
