import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decide, apply } from '../lib/index.js'

const TOOLS = new Set(['generate_comfyui', 'create_skill', 'generate_audio'])
const AUDIT = join(tmpdir(), `dsh-auto-approve-test-${process.pid}.jsonl`)
process.env.DSH_AUTO_APPROVE_AUDIT = AUDIT
try { rmSync(AUDIT, { force: true }) } catch {}

const exec = (name, sessionId = 'session-12345678') => ({
  name,
  arguments: {},
  agent: { session: { id: sessionId } },
})

// 1. allowlisted ask -> allow + audit
{
  const ask = { kind: 'ask', reason: 'Auto review denied tool "generate_comfyui": medium risk' }
  assert.deepEqual(decide(exec('generate_comfyui'), ask, TOOLS), { kind: 'allow' })
}
// 2. non-allowlisted ask unchanged
{
  const ask = { kind: 'ask', reason: 'needs approval' }
  assert.equal(decide(exec('other_tool'), ask, TOOLS), ask)
}
// 3. cost-gate ask preserved
{
  const ask = { kind: 'ask', reason: 'cost-gate: generate_comfyui is gated because model(s) deepseek-flash are in peak hours.' }
  assert.equal(decide(exec('generate_comfyui'), ask, TOOLS), ask)
}
// 4. deny never overridden (non-auto-review)
{
  const deny = { kind: 'deny', reason: 'the user rejected tool "generate_comfyui"' }
  assert.equal(decide(exec('generate_comfyui'), deny, TOOLS), deny)
}
// 4b. auto-review hard deny is overridden for allowlisted tools
{
  const deny = { kind: 'deny', reason: 'Auto review rejected tool "create_skill"; its body was not executed' }
  assert.deepEqual(decide(exec('create_skill'), deny, TOOLS), { kind: 'allow' })
}
// 4c. auto-review deny on a non-allowlisted tool is preserved
{
  const deny = { kind: 'deny', reason: 'Auto review rejected tool "other_tool"; its body was not executed' }
  assert.equal(decide(exec('other_tool'), deny, TOOLS), deny)
}
// 5. allow unchanged
{
  const allow = { kind: 'allow' }
  assert.equal(decide(exec('generate_comfyui'), allow, TOOLS), allow)
}
// 6. hard deny wins even if listed
{
  const ask = { kind: 'ask', reason: 'plugin install' }
  assert.equal(decide(exec('plugin_manager'), ask, new Set(['plugin_manager'])), ask)
}
// 7. audit lines written (ask conversion + auto-review override)
{
  const lines = readFileSync(AUDIT, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const row = JSON.parse(lines[0])
  assert.equal(row.tool, 'generate_comfyui')
  assert.equal(row.decision, 'allowed-once')
  assert.equal(row.sessionTail, '12345678')
  const override = JSON.parse(lines[1])
  assert.equal(override.decision, 'allowed-override')
}

// 8. apply() wires the waterfall (prepended) and converts ask -> allow
{
  let listener = null
  let options = null
  const ctx = {
    effect(fn) { fn() },
    on(event, fn, opts) { assert.equal(event, 'tools/pre-execute'); listener = fn; options = opts },
  }
  apply(ctx)
  assert.equal(typeof listener, 'function')
  assert.equal(options && options.prepend, true)
  const ask = { kind: 'ask', reason: 'Auto review denied' }
  const out = await listener(exec('generate_comfyui'), async () => ask)
  assert.deepEqual(out, { kind: 'allow' })
}

// 9. off switch registers nothing
{
  process.env.DSH_AUTO_APPROVE_OFF = '1'
  let registered = false
  apply({ on() { registered = true }, effect(fn) { fn() } })
  assert.equal(registered, false)
  delete process.env.DSH_AUTO_APPROVE_OFF
}

console.log('auto-approve: 9/9 passed')
