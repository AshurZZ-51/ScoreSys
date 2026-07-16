const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const assert = require('node:assert/strict');
const typescript = require('typescript');
const scoringRules = require('./scoringRules');

const routePath = path.join(__dirname, '..', 'app', 'api', 'summary', 'route.ts');

function query(result) {
  return {
    select() { return this; },
    eq() { return this; },
    order() { return this; },
    single() { return Promise.resolve(result); },
    then(onFulfilled, onRejected) { return Promise.resolve(result).then(onFulfilled, onRejected); }
  };
}

function loadSummaryRoute(responses) {
  const originalLoad = Module._load;
  const originalTypeScriptLoader = Module._extensions['.ts'];

  Module._extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    const output = typescript.transpileModule(source, {
      compilerOptions: {
        module: typescript.ModuleKind.CommonJS,
        target: typescript.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }).outputText;
    module._compile(output, filename);
  };

  Module._load = (request, parent, isMain) => {
    if (request === '@/lib/supabase') {
      return {
        isProjectPoolV2Enabled: () => true,
        supabaseAdmin: {
          from(table) {
            return query(responses[table]);
          }
        }
      };
    }
    if (request === '@/lib/projectSlots') return { getMissingTemplateProjects: () => [] };
    if (request === '@/lib/adminSession') return { requireReviewerSession: () => true };
    if (request === '@/lib/scoringRules') return scoringRules;
    if (request === '@/lib/reviewWorkflow') {
      return {
        defaultRoundForStatus: () => 'r1',
        nextStatusForVerdict: () => 'draft',
        stripRoundPrefix: (value) => value
      };
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[routePath];
  try {
    return require(routePath);
  } finally {
    Module._load = originalLoad;
    Module._extensions['.ts'] = originalTypeScriptLoader;
  }
}

test('summary falls back to legacy totals when the selected V2 round has no score keys', async () => {
  const [gameplay, innovation, planning, technicalArt, risk] = scoringRules.SCORING_DIMENSIONS;
  const historicalScores = [
    { reviewer_code: 'R1', dim_name: `${gameplay.name}::${gameplay.items[0].key}`, score: 5 },
    { reviewer_code: 'R1', dim_name: `${innovation.name}::level`, score: 16 },
    { reviewer_code: 'R1', dim_name: `${planning.name}::${planning.items[0].key}`, score: 5 },
    { reviewer_code: 'R1', dim_name: `${technicalArt.name}::${technicalArt.items[0].key}`, score: 5 },
    { reviewer_code: 'R1', dim_name: `${risk.name}::${risk.items[0].key}`, score: 5 },
    { reviewer_code: 'R1', dim_name: '__bonus__', score: 2, comment: 'Historical bonus' }
  ].map((score) => ({ ...score, project_id: 'project-1' }));
  const route = loadSummaryRoute({
    meetings: { data: { id: 'meeting-1', name: 'Historical meeting' }, error: null },
    projects: {
      data: [{
        id: 'project-1', meeting_id: 'meeting-1', seq_no: 1, name: 'Historical project', submitter: 'Owner',
        scoring_version: 'two_round_v2', round_no: 1
      }],
      error: null
    },
    scores: { data: historicalScores, error: null },
    reviewers: { data: [{ code: 'R1', name: 'Reviewer', is_admin: false }], error: null },
    reviewer_dims: { data: [], error: null }
  });

  const response = await route.GET({ url: 'http://localhost/api/summary?meetingId=meeting-1' });
  const body = await response.json();
  const project = body.projects[0];

  assert.equal(project.roundSummaries.r1.baseScore, 0);
  assert.equal(project.baseScore, 96);
  assert.equal(project.bonusScore, 2);
  assert.equal(project.totalScore, 98);
  assert.equal(project.dimTotals[gameplay.name].score, 30);
});

test('summarizes the second-round risk dimension and gives every reviewer the full round input count', async () => {
  const [,, planning, technicalArt, risk] = scoringRules.SCORING_DIMENSIONS;
  const riskScores = risk.items.map((item) => ({
    project_id: 'project-r2', reviewer_code: 'W', dim_name: scoringRules.roundScoreKey('r2', risk.name, item.key), score: 10
  }));
  const route = loadSummaryRoute({
    meetings: { data: { id: 'meeting-r2', name: 'Second round' }, error: null },
    projects: { data: [{ id: 'project-r2', meeting_id: 'meeting-r2', seq_no: 1, name: 'Risk project', submitter: 'Owner', scoring_version: 'two_round_v2', round_no: 2 }], error: null },
    scores: { data: riskScores, error: null },
    reviewers: { data: [{ code: 'W', name: 'Walker', is_admin: false }, { code: 'J', name: 'Jarvis', is_admin: false }], error: null },
    reviewer_dims: { data: [{ reviewer_code: 'W', dim_name: planning.name, max_score: 10 }], error: null }
  });

  const response = await route.GET({ url: 'http://localhost/api/summary?meetingId=meeting-r2' });
  const body = await response.json();
  const expected = planning.items.length + technicalArt.items.length + risk.items.length;

  assert.equal(body.projects[0].roundSummaries.r2.dimTotals[risk.name].score, 30);
  assert.equal(body.reviewers.find((reviewer) => reviewer.code === 'W').expectedScores, expected);
  assert.equal(body.reviewers.find((reviewer) => reviewer.code === 'J').expectedScores, expected);
});
