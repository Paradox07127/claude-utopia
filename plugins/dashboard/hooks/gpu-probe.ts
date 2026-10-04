import type { GpuProcess, GpuSample, NvidiaGpu } from '../types'

const NVSMI = '@@NVSMI'
const APPS = '@@APPS'
const NVERR = '@@NVERR'
const TEGRA = '@@TEGRA'
const NOGPU = '@@NOGPU'
const END = '@@END'

/**
 * Read-only probe run by `sh -c` on the remote host. tegrastats also runs when nvidia-smi
 * failed or reported `N/A` (Jetson ships an nvidia-smi that cannot read its iGPU).
 * Must contain no single quote: it is wrapped in one for the remote login shell.
 */
export const REMOTE_SCRIPT = [
  'nv=1',
  'if command -v nvidia-smi >/dev/null 2>&1; then',
  '  if g=$(nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>&1); then',
  `    echo ${NVSMI}; echo "$g"; echo ${APPS}`,
  '    nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null',
  '    case "$g" in *N/A*) nv=0 ;; esac',
  `  else echo ${NVERR}; echo "$g" | head -3; nv=0; fi`,
  'else nv=0; fi',
  'if [ $nv = 0 ]; then',
  `  if command -v tegrastats >/dev/null 2>&1; then echo ${TEGRA}; timeout 2 tegrastats --interval 500 | head -1`,
  `  else echo ${NOGPU}; fi`,
  'fi',
].join('\n')

/** The probe every 3 s for as long as the connection lasts, each pass closed by an END line. */
const REMOTE_LOOP = ['while :; do', REMOTE_SCRIPT, `echo ${END}`, 'sleep 3', 'done'].join('\n')

/** One ssh streaming a pass every 3 s; the keepalives end it within about 10 s of the host going silent. */
export function sshArgv(host: string): string[] {
  return [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPath=~/.ssh/cm-%C',
    '-o', 'ControlPersist=10m',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    host,
    `sh -c '${REMOTE_LOOP}'`,
  ]
}

/** A host name `/gpu` accepts: no leading `-`, so it can never be read as an ssh option. */
export const isHostName = (host: string) => /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/.test(host)

/** nvidia-smi `nounits` field; `[N/A]`, `[Not Supported]` and the like read as null. */
function num(field: string | undefined): number | null {
  const value = Number((field ?? '').trim())

  return field === undefined || field.trim() === '' || Number.isNaN(value) ? null : value
}

export function parseNvidiaCsv(text: string): NvidiaGpu[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .flatMap(line => {
      const fields = line.split(',').map(field => field.trim())

      if (fields.length < 7) {
        return []
      }

      // A name containing commas spreads over the middle fields.
      const tail = fields.slice(-5)
      const index = num(fields[0])

      return index === null
        ? []
        : [{
            index,
            name: fields.slice(1, -5).join(', '),
            util: num(tail[0]),
            memUsed: num(tail[1]),
            memTotal: num(tail[2]),
            temp: num(tail[3]),
            power: num(tail[4]),
          }]
    })
}

export function parseApps(text: string): GpuProcess[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .flatMap(line => {
      const fields = line.split(',').map(field => field.trim())
      const pid = num(fields[0])

      if (pid === null || fields.length < 3) {
        return []
      }

      const path = fields.slice(1, -1).join(', ')

      return [{ pid, name: path.split('/').pop() || path, memMiB: num(fields[fields.length - 1]) }]
    })
}

export function parseTegra(line: string): Extract<GpuSample, { kind: 'tegra' }> | null {
  const util = /GR3D_FREQ (\d+)%/.exec(line)
  const ram = /RAM (\d+)\/(\d+)MB/.exec(line)
  const temp = /\bgpu@(-?[\d.]+)C/i.exec(line)

  if (util === null && ram === null) {
    return null
  }

  return {
    kind: 'tegra',
    util: util ? Number(util[1]) : null,
    ramUsed: ram ? Number(ram[1]) : null,
    ramTotal: ram ? Number(ram[2]) : null,
    temp: temp ? Number(temp[1]) : null,
  }
}

function sectionsOf(stdout: string): Map<string, string> {
  const sections = new Map<string, string>()
  let current: string | null = null

  for (const line of stdout.split('\n')) {
    if (/^@@[A-Z]+$/.test(line.trim())) {
      current = line.trim()
      sections.set(current, '')
    } else if (current !== null) {
      sections.set(current, `${sections.get(current)}${line}\n`)
    }
  }

  return sections
}

const firstLine = (text: string) => text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''

/** Reads one probe run's output into a sample; `error` carries the line worth showing. */
export function parseProbe(run: { exitCode: number; stdout: string; stderr: string }): GpuSample {
  const sections = sectionsOf(run.stdout)
  const gpus = parseNvidiaCsv(sections.get(NVSMI) ?? '')

  if (gpus.some(gpu => gpu.util !== null)) {
    return { kind: 'nvidia', gpus, procs: parseApps(sections.get(APPS) ?? '') }
  }

  const tegra = parseTegra(sections.get(TEGRA) ?? '')

  if (tegra !== null) {
    return tegra
  }

  const nvError = firstLine(sections.get(NVERR) ?? '')

  if (nvError !== '') {
    return { kind: 'error', message: nvError }
  }

  if (sections.has(NOGPU) && !sections.has(NVSMI)) {
    return { kind: 'none' }
  }

  if (sections.has(TEGRA)) {
    return { kind: 'error', message: 'tegrastats printed nothing' }
  }

  if (gpus.length > 0) {
    return { kind: 'nvidia', gpus, procs: parseApps(sections.get(APPS) ?? '') }
  }

  return { kind: 'error', message: firstLine(run.stderr) || firstLine(run.stdout) || `ssh exited ${run.exitCode}` }
}

/** The passes complete in `text`, the stream read so far, as samples; `rest` is the unfinished pass to read on with the next piece. */
export function takeSamples(text: string): { samples: GpuSample[]; rest: string } {
  const lines = text.split('\n')
  const tail = lines.pop() ?? ''
  const samples: GpuSample[] = []
  let pass: string[] = []

  for (const line of lines) {
    if (line.trim() === END) {
      samples.push(parseProbe({ exitCode: 0, stdout: pass.join('\n'), stderr: '' }))
      pass = []
    } else {
      pass.push(line)
    }
  }

  return { samples, rest: [...pass, tail].join('\n') }
}

/** ssh options that take a value (`ssh -p 22 host`), from ssh(1). */
const SSH_VALUE_FLAGS = new Set('BbcDEeFIiJLlmOoPpQRSWw')

/** The host a command starting with `ssh [options] [user@]host` connects to, else null. */
export function sshHostOf(command: string): string | null {
  const words = command.trim().split(/\s+/)

  if (words[0] !== 'ssh') {
    return null
  }

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] ?? ''

    if (word === '--') {
      return hostOf(words[i + 1])
    }

    if (!word.startsWith('-')) {
      return hostOf(word)
    }

    // A clustered flag (`-tt`, `-p22`) takes the next word only when it ends in a value flag.
    const letters = word.slice(1)
    const valueAt = [...letters].findIndex(letter => SSH_VALUE_FLAGS.has(letter))

    if (valueAt === letters.length - 1) {
      i += 1
    }
  }

  return null
}

function hostOf(word: string | undefined): string | null {
  if (word === undefined || word === '') {
    return null
  }

  const host = word.replace(/^ssh:\/\//, '').replace(/^[^@]*@/, '').replace(/:\d+$/, '')

  return host === '' ? null : host
}

export function hostsOf(option: unknown): string[] {
  return typeof option === 'string'
    ? option.split(',').map(host => host.trim()).filter(host => host !== '')
    : []
}

/** A bar of `width` cells, `fraction` of it filled. */
export function bar(fraction: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)

  return '▇'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}
