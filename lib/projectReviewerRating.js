const PROJECT_RATING_VALUES = new Set(['S', 'A', 'B', 'C']);

function normalizeProjectRating(value) {
  const rating = String(value || '').trim().toUpperCase();
  return PROJECT_RATING_VALUES.has(rating) ? rating : null;
}

function isProjectReviewerRating(value) {
  return normalizeProjectRating(value) !== null;
}

module.exports = { PROJECT_RATING_VALUES, normalizeProjectRating, isProjectReviewerRating };
