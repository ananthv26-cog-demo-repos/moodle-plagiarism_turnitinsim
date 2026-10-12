# Turnitin Integrity plugin: end-to-end test harness

Runs the real `plagiarism_turnitinsim` plugin inside Moodle 4.5 against a local
stand-in for the Turnitin API, and drives the whole instructor/student workflow
through the browser with Playwright. No Turnitin credentials, nothing leaves
the machine.

```
e2e/
  docker-compose.yml   Moodle 4.5 (PHP 8.3) + Postgres 16 + mock Turnitin API
  up.sh                one-shot: clone Moodle, start, install, seed
  cli/seed.php         course, users, plugin config, webhook + EULA registration
  moodle/config.php    Moodle config used inside the container
  mock-turnitin/       dependency-free Node server implementing the TCA endpoints the plugin calls
  playwright/          the E2E suite + fixture essays
```

## Run it

```bash
cd e2e
./up.sh                                   # first run ~3 min (Moodle install)
cd playwright && npm install && npx playwright install chromium
npx playwright test                       # ~45s
npx playwright show-report
```

| URL | What |
|---|---|
| http://localhost:8080 | Moodle. `admin / Admin-123!`, `dana.whitfield` (instructor), `priya.nair`, `marcus.bell`, `leo.okafor` (students) all `Demo-Pass1!` |
| http://localhost:8090 | Mock Turnitin console: every API call, webhook delivery and viewer launch the plugin made |

## What the mock does

The plugin's admin form only accepts `*.turnitin.com` / `*.tii-sandbox.com`
API hosts, so the mock is reachable inside the compose network as
`mock.tii-sandbox.com`. It implements:

- `features-enabled`, `eula/latest` (+ a readable EULA page), webhook CRUD with
  HMAC-SHA256 signing, exactly as `callbacks.php` verifies it
- `submissions` create / `original` upload / status / `similarity` generation /
  `viewer-url`
- deterministic similarity scoring: 5-word shingles against a small corpus
  (`corpus.txt`: one Internet, one publication, one student-paper source) so
  the same essay always gets the same score and the viewer can highlight the
  matched passages
- webhooks (`SUBMISSION_COMPLETE`, `SIMILARITY_COMPLETE`) fired back into
  Moodle ~1.5s after each request, so a full submission round-trip takes
  seconds instead of Turnitin's real minutes
- `/__mock/state`, `/__mock/requests`, `/__mock/reset` for assertions

## What the suite covers

`01-similarity-workflow.spec.ts`
1. Instructor creates an assignment with Turnitin Integrity on
2. Priya accepts the EULA and uploads an essay lifted from Wikipedia
3. Marcus uploads an original essay
4. `send_submissions` cron task pushes both; webhooks return reports; the
   plugin sent real owner metadata because blind marking is off
5. Instructor sees each student's own score on the grading table
6. Instructor opens the viewer: score, author, INSTRUCTOR role, highlighted
   matches, sources
7. Priya sees her own score and opens the viewer as a LEARNER
8. Priya resubmits a rewritten draft: new Turnitin submission, lower score

`02-anonymous-marking.spec.ts`
- With Moodle blind marking on, no name/email reaches Turnitin in the
  submission metadata or the viewer launch, while the instructor still sees
  the score

Cron tasks are run the way Moodle would run them
(`admin/cli/scheduled_task.php` inside the container), not by poking the DB.
