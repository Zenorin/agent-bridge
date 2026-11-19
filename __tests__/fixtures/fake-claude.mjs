// Claude stream-json shapes observed in workorder §8.1.3; no model or Claude binary.
import { appendFileSync, readFileSync } from 'node:fs';
import {receiptFor} from '../../contracts.mjs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'pass';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const packet = JSON.parse(input);
  const session = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    args, packet, pid: process.pid,
    diff: packet.file_refs.filter(ref => ref.path.endsWith('.diff')).map(ref => readFileSync(ref.path, 'utf8')),
  }) + '\n');
  const send = event => process.stdout.write(JSON.stringify(event) + '\n');
  send({ type: 'system', subtype: 'init', session_id: session,
    tools: ['Read', 'Grep', 'Glob', 'StructuredOutput'], permissionMode: 'dontAsk' });
  if (mode === 'slow') { setInterval(() => {}, 1000); return; }
  if (mode === 'malformed') { process.stdout.write('not JSON\n'); return; }
  if (mode === 'crash') { process.exitCode = 3; return; }
  if (mode !== 'no-hooks') {
    send({ type: 'system', subtype: 'hook_started', hook_name: 'UserPromptSubmit', hook_event: 'UserPromptSubmit' });
    if (mode !== 'started-only') send({ type: 'system', subtype: 'hook_response', hook_name: 'UserPromptSubmit',
      hook_event: 'UserPromptSubmit', exit_code: 0, outcome: 'success', stdout: '', stderr: '' });
  }
  const denied = { tool_name: 'Write', tool_use_id: 'tool-1', tool_input: { file_path: 'intruder.txt', content: 'bad' } };
  const disallowed = ['disallowed', 'denial-only', 'result-denial'].includes(mode);
  if (!['denial-only', 'result-denial'].includes(mode)) send({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'tool-1', name: disallowed ? 'Write' : 'Read', input: { file_path: 'a.txt' } },
  ] } });
  if (['disallowed', 'denial-only'].includes(mode)) send({ type: 'system', subtype: 'permission_denied', ...denied, decision_reason_type: 'mode' });
  const reject = mode === 'roundtrip' && !args.includes('--resume');
  const review = { status: 'done', verdict: reject ? 'reject' : 'pass', summary: 'fixture review',
    criteria: [{ criterion: 'fixture criterion', result: reject ? 'fail' : 'pass', evidence: 'fake Claude only' }],
    findings: reject ? [{ criterion: 'fixture criterion', problem: 'missing case', required_change: 'fix a.txt', files: ['a.txt'] }] : [],
    boundary_review: { paths: 'unchanged', exec: 'unchanged', auth_permissions: 'unchanged', notes: 'fixture' },
  };
  if(packet.contract){review.criteria=packet.step.acceptance.map(criterion=>({criterion,result:'pass',evidence:'fake reviewer received exact packet'}));
    review.contract_receipt=receiptFor({...packet,...packet.step},packet.contract_environment,review.criteria);
    if(mode==='omit-review-id')review.contract_receipt.review.pop();}
  send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'structured', name: 'StructuredOutput', input: review }] } });
  send({ type: 'result', subtype: 'success', session_id: session, is_error: false,
    ...(mode === 'text-result' ? {} : { structured_output: review }), result: JSON.stringify(review),
    usage: { input_tokens: 12, cache_creation_input_tokens: 30, cache_read_input_tokens: 40, output_tokens: 5 },
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 12, outputTokens: 5 } }, total_cost_usd: 0.001,
    permission_denials: disallowed ? [denied] : [],
  });
});
