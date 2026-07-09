function hasProjectIdentity(project) {
  return Boolean(project?.name?.trim() && project?.submitter?.trim());
}

function projectDisplayName(project) {
  const name = project?.name?.trim();
  if (name) return name;
  return `未填写项目 #${project?.seq_no ?? '-'}`;
}

function projectDisplaySubmitter(project) {
  const submitter = project?.submitter?.trim();
  return submitter || '未填写提报人';
}

function shouldShowProjectSlot(project) {
  return Boolean(project?.id);
}

module.exports = {
  hasProjectIdentity,
  projectDisplayName,
  projectDisplaySubmitter,
  shouldShowProjectSlot
};
