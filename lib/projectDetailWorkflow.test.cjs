const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workflow = require('./projectDetailWorkflow');

test('uses the dedicated material response when reopening a project detail', () => {
  const project = { id: 'project-1', project_materials: [] };
  const materials = [{ item_key: 'basic_info', status: 'submitted' }];

  assert.deepEqual(workflow.mergeProjectMaterials(project, materials), {
    id: 'project-1',
    project_materials: materials
  });
});

test('only Walker can edit the final project rating', () => {
  assert.equal(workflow.canEditFinalRating('W'), true);
  assert.equal(workflow.canEditFinalRating('walker'), true);
  assert.equal(workflow.canEditFinalRating('Jarvis'), false);
  assert.equal(workflow.canEditFinalRating('Gouki'), false);
});

test('removes the final rating control from every reviewer scoring page', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'scoring', 'page.tsx'), 'utf8');
  assert.doesNotMatch(source, /<label[^\n]*最终评级/);
  assert.match(source, /特别推荐票/);
});
