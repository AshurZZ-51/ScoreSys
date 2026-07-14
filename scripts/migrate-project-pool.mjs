import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import workflow from '../lib/projectPoolWorkflow.js';

const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0 && !line.startsWith('#')) process.env[line.slice(0, index)] ||= line.slice(index + 1);
  }
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const apply = process.argv.includes('--apply');
const operator = (process.argv.find((arg) => arg.startsWith('--operator=')) || '--operator=walker').split('=')[1];

const { data: legacyRows, error: legacyError } = await supabase
  .from('projects')
  .select('id, name, submitter, description, created_at')
  .neq('name', '')
  .neq('submitter', '')
  .is('pool_project_id', null)
  .order('created_at');
if (legacyError) throw legacyError;

const groups = new Map();
for (const row of legacyRows || []) {
  const key = workflow.makeMatchKey(row.name, row.submitter);
  const group = groups.get(key) || [];
  group.push(row); groups.set(key, group);
}
const summary = { legacyProjects: legacyRows?.length || 0, masters: groups.size, mergedGroups: [...groups.values()].filter((rows) => rows.length > 1).length };
if (!apply) { console.log(JSON.stringify(summary, null, 2)); process.exit(0); }

const { data: batch, error: batchError } = await supabase.from('project_migration_batches').insert({ operator_code: operator, status: 'running', dry_run: summary }).select().single();
if (batchError) throw batchError;
let mapped = 0;
for (const [matchKey, rows] of groups) {
  const newest = rows.at(-1);
  const { data: pool, error: poolError } = await supabase.from('project_pool').insert({
    name: newest.name, submitter: newest.submitter, description: newest.description || '',
    normalized_name: workflow.normalizeProjectPart(newest.name), normalized_submitter: workflow.normalizeProjectPart(newest.submitter),
    match_key: matchKey, status: 'draft', material_status: 'unchecked'
  }).select().single();
  if (poolError) throw poolError;
  const { error: materialsError } = await supabase.from('project_materials').insert(workflow.createMaterialRows(pool.id));
  if (materialsError) throw materialsError;
  const { error: mapError } = await supabase.from('project_migration_map').insert(rows.map((row) => ({ legacy_project_id: row.id, pool_project_id: pool.id, batch_id: batch.id, match_key: matchKey })));
  if (mapError) throw mapError;
  const { error: linkError } = await supabase.from('projects').update({ pool_project_id: pool.id, migration_batch_id: batch.id, scoring_version: 'legacy_v1' }).in('id', rows.map((row) => row.id));
  if (linkError) throw linkError;
  await supabase.from('project_status_history').insert({ project_id: pool.id, event_type: 'legacy_migrated', to_status: 'draft', operator_code: operator, note: `迁移 ${rows.length} 条历史评审记录` });
  mapped += rows.length;
}
const result = { ...summary, mapped };
const { error: completeError } = await supabase.from('project_migration_batches').update({ status: 'completed', result, completed_at: new Date().toISOString() }).eq('id', batch.id);
if (completeError) throw completeError;
console.log(JSON.stringify(result, null, 2));
