function mergeProjectMaterials(project, fetchedMaterials) {
  const nestedMaterials = Array.isArray(project?.project_materials) ? project.project_materials : [];
  return {
    ...project,
    project_materials: Array.isArray(fetchedMaterials) ? fetchedMaterials : nestedMaterials
  };
}

function canEditFinalRating(reviewerCode) {
  const code = String(reviewerCode || '').trim().toUpperCase();
  return code === 'W' || code === 'WALKER';
}

module.exports = {
  mergeProjectMaterials,
  canEditFinalRating
};
