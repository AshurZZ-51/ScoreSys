const test = require('node:test');
const assert = require('node:assert/strict');
const slots = require('./projectSlots.js');

test('creates twelve empty project templates for a new meeting', () => {
  const projects = slots.createTemplateProjects('meeting-1');

  assert.equal(slots.PROJECT_SLOT_COUNT, 12);
  assert.equal(projects.length, 12);
  assert.deepEqual(projects.map((project) => project.seq_no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(projects[11].meeting_id, 'meeting-1');
  assert.equal(projects[11].name, '');
  assert.equal(projects[11].submitter, '');
  assert.equal(projects[11].is_template, true);
});

test('copies at most twelve projects into a new meeting', () => {
  const sourceProjects = Array.from({ length: 13 }, (_, index) => ({
    seq_no: index + 1,
    name: `project-${index + 1}`,
    submitter: `submitter-${index + 1}`,
    description: '',
    problems: [],
    actions: [],
    is_pending: false
  }));

  const copied = slots.copyProjectsForMeeting(sourceProjects, 'meeting-2');

  assert.equal(copied.length, 12);
  assert.equal(copied[0].meeting_id, 'meeting-2');
  assert.equal(copied[0].is_template, false);
  assert.equal(copied[11].seq_no, 12);
  assert.equal(copied.at(-1).name, 'project-12');
});
