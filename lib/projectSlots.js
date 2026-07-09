const PROJECT_SLOT_COUNT = 12;

function createTemplateProjects(meetingId) {
  return Array.from({ length: PROJECT_SLOT_COUNT }, (_, index) => ({
    meeting_id: meetingId,
    seq_no: index + 1,
    name: '',
    submitter: '',
    description: '',
    is_template: true,
    problems: [],
    actions: []
  }));
}

function copyProjectsForMeeting(sourceProjects, meetingId) {
  return (sourceProjects || []).slice(0, PROJECT_SLOT_COUNT).map((project) => ({
    ...project,
    meeting_id: meetingId,
    is_template: false
  }));
}

module.exports = {
  PROJECT_SLOT_COUNT,
  createTemplateProjects,
  copyProjectsForMeeting
};
