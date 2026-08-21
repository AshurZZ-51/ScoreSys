const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProjectRating, isProjectReviewerRating } = require('./projectReviewerRating');

test('project reviewer ratings accept only S/A/B/C', () => {
  assert.equal(isProjectReviewerRating('s'), true);
  assert.equal(normalizeProjectRating(' s '), 'S');
  assert.equal(isProjectReviewerRating('A'), true);
  assert.equal(isProjectReviewerRating('D'), false);
  assert.equal(normalizeProjectRating(''), null);
});

test('project reviewer rating identity is scoped to an assignment and reviewer', () => {
  const key = ({ project_id: 'assignment-1', reviewer_code: 'N' });
  assert.equal(`${key.project_id}:${key.reviewer_code.toLowerCase()}`, 'assignment-1:n');
});
