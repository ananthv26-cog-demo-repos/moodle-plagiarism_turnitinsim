<?php  // Moodle configuration file for the Turnitin Integrity E2E harness.

unset($CFG);
global $CFG;
$CFG = new stdClass();

$CFG->dbtype    = 'pgsql';
$CFG->dblibrary = 'native';
$CFG->dbhost    = 'db';
$CFG->dbname    = 'moodle';
$CFG->dbuser    = 'moodle';
$CFG->dbpass    = 'moodle';
$CFG->prefix    = 'mdl_';
$CFG->dboptions = ['dbpersist' => 0, 'dbport' => 5432];

$CFG->wwwroot   = 'http://localhost:8080';
$CFG->dataroot  = '/var/www/moodledata';
$CFG->admin     = 'admin';
$CFG->directorypermissions = 02777;

$CFG->noemailever = true;
$CFG->debug = E_ALL;
$CFG->debugdisplay = 0;

require_once(__DIR__ . '/lib/setup.php');
