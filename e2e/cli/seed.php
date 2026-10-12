<?php
// Seeds the Northgate University demo site: course, users, enrolments and the
// Turnitin Integrity plugin pointed at the mock API. Run inside the moodle
// container:  php plagiarism/turnitinsim/e2e/cli/seed.php
define('CLI_SCRIPT', true);
require(__DIR__ . '/../../../../config.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->libdir . '/adminlib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/lib/enrollib.php');
require_once($CFG->dirroot . '/plagiarism/turnitinsim/lib.php');
require_once($CFG->dirroot . '/plagiarism/turnitinsim/classes/task.class.php');

$apiurl = getenv('TII_APIURL') ?: 'http://mock.tii-sandbox.com';
$apikey = getenv('TII_APIKEY') ?: 'northgate-sandbox-key';

// Site settings that keep a demo site predictable.
set_config('passwordpolicy', 0);
set_config('cronclionly', 0);
set_config('noemailever', 1);
set_config('enableplagiarism', 1);
set_config('timezone', 'America/New_York');
set_config('registerauth', '');
set_config('sitepolicyhandler', '');
set_config('showuseridentity', 'email');

// Course.
if (!$course = $DB->get_record('course', ['shortname' => 'ENG201'])) {
    $course = create_course((object)[
        'fullname' => 'ENG 201: Academic Writing',
        'shortname' => 'ENG201',
        'category' => $DB->get_field_sql('SELECT MIN(id) FROM {course_categories}'),
        'format' => 'topics',
        'numsections' => 2,
        'visible' => 1,
    ]);
    cli_writeln("Created course {$course->shortname} (id {$course->id})");
}

// Users: username => [first, last, role]
$people = [
    'dana.whitfield' => ['Dana', 'Whitfield', 'editingteacher'],
    'priya.nair'     => ['Priya', 'Nair', 'student'],
    'marcus.bell'    => ['Marcus', 'Bell', 'student'],
    'leo.okafor'     => ['Leo', 'Okafor', 'student'],
];
$roles = $DB->get_records_menu('role', null, '', 'shortname, id');
foreach ($people as $username => [$first, $last, $role]) {
    if (!$user = $DB->get_record('user', ['username' => $username])) {
        $userid = user_create_user((object)[
            'username' => $username,
            'password' => 'Demo-Pass1!',
            'firstname' => $first,
            'lastname' => $last,
            'email' => "$username@northgate.edu",
            'confirmed' => 1,
            'mnethostid' => $CFG->mnet_localhost_id,
            'auth' => 'manual',
        ], false, false);
        $user = $DB->get_record('user', ['id' => $userid]);
        cli_writeln("Created user $username");
    }
    update_internal_user_password($user, 'Demo-Pass1!', false);
    enrol_try_internal_enrol($course->id, $user->id, $roles[$role]);
}

// Plugin configuration (what an admin would do on the Setup tab).
plagiarism_plugin_turnitinsim::enable_plugin(1);
set_config('turnitinapiurl', $apiurl, 'plagiarism_turnitinsim');
set_config('turnitinapikey', $apikey, 'plagiarism_turnitinsim');
set_config('turnitinmodenabledassign', 1, 'plagiarism_turnitinsim');
set_config('turnitinmodenabledforum', 1, 'plagiarism_turnitinsim');
set_config('turnitinmodenabledworkshop', 0, 'plagiarism_turnitinsim');
set_config('turnitinmodenabledquiz', 0, 'plagiarism_turnitinsim');
set_config('turnitinenablelogging', 1, 'plagiarism_turnitinsim');
set_config('turnitinenableremotelogging', 0, 'plagiarism_turnitinsim');
set_config('turnitinhideidentity', 0, 'plagiarism_turnitinsim');
set_config('turnitinviewerviewfullsource', 1, 'plagiarism_turnitinsim');
set_config('turnitinviewermatchsubinfo', 1, 'plagiarism_turnitinsim');
set_config('turnitinviewersavechanges', 1, 'plagiarism_turnitinsim');

// Plugin defaults for new activities: report immediately, show reports to students.
$defaults = $DB->get_record('plagiarism_turnitinsim_mod', ['cm' => 0]) ?: (object)['cm' => 0];
$defaults->turnitinenabled = 1;
$defaults->reportgeneration = 0;
$defaults->accessstudents = 1;
$defaults->excludequotes = 1;
$defaults->excludebiblio = 1;
$defaults->addtoindex = 1;
$defaults->queuedrafts = 1;
if (empty($defaults->id)) {
    $DB->insert_record('plagiarism_turnitinsim_mod', $defaults);
} else {
    $DB->update_record('plagiarism_turnitinsim_mod', $defaults);
}

// Pull features, register the webhook and fetch the EULA from the (mock) API.
$task = new plagiarism_turnitinsim_task();
$task->admin_update();

purge_all_caches();
cli_writeln("Seed complete. Admin: admin / Admin-123!  Everyone else: Demo-Pass1!");
