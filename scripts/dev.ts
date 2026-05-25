#!/usr/bin/env bun
/**
 * Geostack local launcher (Bun).
 *
 * One command brings up the whole local-first stack as a persistent
 * knowledge-work surface — you keep it open, iterate on articles, view
 * outputs, all from one place. No "work vs browse" modes.
 *
 *   coral-server (pinned npx)  :5555   ← supervised child; spawns the agents
 *   conductor / engine + API   :8787   ← orchestration + Turso/libsql archive
 *   app (Vite UI)              :5174   ← the only port you actually open
 *
 * Ctrl-C tears the entire process tree down cleanly (each child runs in its
 * own process group; we signal the group, then sweep the known ports).
 *
 * Config lives in (consolidating to one file is a follow-up):
 *   - geostack-agents/.env      OPENROUTER_API_KEY (+ optional EXA_API_KEY)
 *   - geostack-conductor/.env   TURSO_* (optional — archive no-ops without it)
 *   - .env (this dir)           VITE_* for the app
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

// PINNED — never `@latest`. `@latest` resolves to a stale 1.1.0 dev snapshot
// with a polymorphic-TOML regression that rejects our agent license blocks.
// See docs/notes/npx-coral-server-port.md.
const CORAL_VERSION = 'coralos-dev@RC-1.2.0'
const AUTH_KEY = 'local' // matches the conductor's CORAL_TOKEN default

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const AGENTS_DIR = join(ROOT, 'geostack-agents')
const CONDUCTOR_DIR = join(ROOT, 'geostack-conductor')
const APP_DIR = join(ROOT, 'app')
const AGENTS = ['exa-agent', 'deepwiki-agent', 'geo-agent', 'verify-agent', 'style-agent']
const PORTS = [5555, 8787, 5174]

// ---- pretty prefixed logging ------------------------------------------------
const C = {
  coral: '\x1b[36m', // cyan
  conductor: '\x1b[35m', // magenta
  app: '\x1b[32m', // green
  launcher: '\x1b[33m', // yellow
  reset: '\x1b[0m',
  dim: '\x1b[2m',
}
type Tag = 'coral' | 'conductor' | 'app' | 'launcher'
function log(tag: Tag, msg: string) {
  for (const line of msg.split('\n')) {
    if (line.trim() === '') continue
    console.log(`${C[tag]}[${tag}]${C.reset} ${line}`)
  }
}
function pipe(tag: Tag, child: ChildProcess) {
  child.stdout?.on('data', (d) => log(tag, d.toString()))
  child.stderr?.on('data', (d) => log(tag, d.toString()))
}

// ---- 1. preflight: ensure agents are linked into ~/.coral/agents ------------
function ensureLinked() {
  for (const a of AGENTS) {
    if (existsSync(join(homedir(), '.coral', 'agents', a))) continue
    log('launcher', `linking ${a} (coralizer)…`)
    const r = spawnSync('npx', ['-y', '@coral-protocol/coralizer@latest', 'link', '.'], {
      cwd: join(AGENTS_DIR, 'coral', a),
      stdio: 'inherit',
    })
    if (r.status !== 0) log('launcher', `⚠ failed to link ${a} (status ${r.status})`)
  }
}

// ---- 2. spawn supervised children (own process group) -----------------------
const children: ChildProcess[] = []
function start(tag: Tag, cmd: string, args: string[], env: Record<string, string> = {}, cwd = ROOT) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true, // own process group → killable as a tree
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipe(tag, child)
  child.on('exit', (code, signal) =>
    log('launcher', `${tag} exited${code != null ? ` (code ${code})` : ''}${signal ? ` (${signal})` : ''}`)
  )
  children.push(child)
  return child
}

// ---- 3. teardown ------------------------------------------------------------
let shuttingDown = false
function shutdown(reason: string) {
  if (shuttingDown) return
  shuttingDown = true
  log('launcher', `\n${reason} — shutting down the stack…`)
  for (const c of children) {
    if (c.pid) {
      try {
        process.kill(-c.pid, 'SIGTERM') // negative pid = kill the group
      } catch {
        /* already gone */
      }
    }
  }
  // Belt-and-suspenders: sweep known ports for survivors (the JVM under npx
  // can outlive its npm/npx wrapper).
  setTimeout(() => {
    for (const p of PORTS) {
      const pids = spawnSync('lsof', ['-ti', `tcp:${p}`], { encoding: 'utf-8' }).stdout?.trim()
      if (pids) for (const pid of pids.split('\n')) try { process.kill(Number(pid), 'SIGKILL') } catch {}
    }
    log('launcher', 'down. bye 👋')
    process.exit(0)
  }, 1500)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// ---- go ---------------------------------------------------------------------
log('launcher', 'Geostack — local stack starting. Ctrl-C stops everything.')
ensureLinked()

// coral-server first (slowest, JVM); conductor + app tolerate it not being
// ready yet (they only need it once you start a run).
start('coral', 'npx', ['-y', CORAL_VERSION, 'server', 'start', '--', `--auth.keys=${AUTH_KEY}`])
start('conductor', 'npm', ['start'], { PORT: '8787' }, CONDUCTOR_DIR)
start('app', 'npm', ['run', 'dev'], {}, APP_DIR)

log('launcher', `${C.dim}UI → http://localhost:5174   API → http://localhost:8787   coral → http://localhost:5555${C.reset}`)
