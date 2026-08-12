const test = require('node:test');
const assert = require('node:assert/strict');
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
