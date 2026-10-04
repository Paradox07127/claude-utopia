import type { ToolSpec } from 'claude-code'

import type { BoardEvent, BoardFields, BoardKind, BoardLink, BoardNode, BoardStatus } from '../types'
import { dayOf } from './usage'

export type BoardStorage = 'local' | 'git'

const STATUSES: BoardStatus[] = ['todo', 'doing', 'done', 'blocked']
const KINDS: BoardKind[] = ['feature', 'fix', 'research', 'infra', 'docs']
const MAX_NODES = 5
const TITLE_CHARS = 60
const SUMMARY_CHARS = 400
const LISTED_NODES = 30
// The most writes one ArtifactData batch carries.
const CANVAS_WRITES = 50

const NODE_IDS = { type: 'array', items: { type: 'string' } }

/** The tool the main model calls at the end of a conversation; its description sits in the prompt cache, so nothing in it varies. */
export const PROGRESS_TOOL: ToolSpec = {
  name: 'progress',
  description:
    "Record this conversation's work on the project progress board. Call it once, before your final reply, when the work the person asked for in this conversation is finished or paused. Do not call it for questions, chat, notifications, scheduled prompts or messages from other sessions. Submit one node per coherent piece of work; split a conversation into several nodes only when it delivered clearly separate features (usually 1–3). Each node: title (≤60 chars); summary (≤400 chars: what changed and why; no secrets, no file contents); status todo | doing | done | blocked; kind feature | fix | research | infra | docs; builds_on: ids of earlier nodes it extends; depends_on: ids that must finish first, marked proposed unless the person confirmed. If the tool answers with a storage question, ask the person with AskUserQuestion, then call it again with their answer.",
  inputSchema: {
    type: 'object',
    properties: {
      nodes: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_NODES,
        description:
          'The nodes to record, 1 to 5. Call with list: true first to find the ids for builds_on, depends_on and updates. A node may refer to another node of this call by its array index, "#0", "#1". A new node needs title, summary, status and kind; an update (with id) gives only what changes.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: "An existing node's id: update its status, title or summary instead of adding a node." },
            title: { type: 'string', maxLength: TITLE_CHARS, description: 'What the work delivered, at most 60 characters.' },
            summary: { type: 'string', maxLength: SUMMARY_CHARS, description: 'What changed and why, at most 400 characters; no secrets, no file contents.' },
            status: { type: 'string', enum: STATUSES },
            kind: { type: 'string', enum: KINDS },
            builds_on: { ...NODE_IDS, description: 'Ids of earlier nodes this one extends, or "#<index>" of a node in this call.' },
            depends_on: {
              type: 'array',
              description: 'Nodes that must finish first: an id, or "#<index>" of a node in this call.',
              items: {
                type: 'object',
                properties: { id: { type: 'string' }, confirmed: { type: 'boolean', description: 'true only when the person confirmed this dependency; false marks it proposed.' } },
                required: ['id', 'confirmed'],
              },
            },
          },
        },
      },
      storage: { type: 'string', enum: ['local', 'git'], description: "Only when answering the storage question: the person's choice." },
      list: { type: 'boolean', description: 'true, without nodes: answer the 30 most recent nodes (id, title, status, kind, date) and record nothing.' },
    },
  },
}

export const boardDir = (home: string, project: string) => `${home}/.claude/progress/${project}`

/** Where the progress canvas's Artifact url is kept, one for every project. */
export const canvasPath = (home: string) => `${home}/.claude/progress/canvas.json`

/** Where the events of a board kept by `storage` lie: under the home directory, or in the session root to be committed. */
export const eventsDir = (storage: BoardStorage, home: string, project: string, root: string) =>
  storage === 'local' ? `${boardDir(home, project)}/events` : `${root}/.notes/board/events`

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The storage a config.json names; null when there is none or it names neither. */
export function parseStorage(text: string): BoardStorage | null {
  try {
    const raw: unknown = JSON.parse(text)

    return isRecord(raw) && (raw.storage === 'local' || raw.storage === 'git') ? raw.storage : null
  } catch {
    return null
  }
}

const isEvent = (one: unknown) => isRecord(one) && (one.type === 'add' || one.type === 'update') && typeof one.node === 'string' && typeof one.at === 'number' && isRecord(one.fields)

/** A session's events file; null for one cut mid-write, or not of this shape. */
export function parseBoardEvents(text: string): BoardEvent[] | null {
  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  return Array.isArray(raw) && raw.every(isEvent) ? (raw as BoardEvent[]) : null
}

/** The nodes the events make, in the order they were added: each event in time order, its fields over the node's. */
export function foldBoard(events: readonly BoardEvent[]): BoardNode[] {
  const nodes = new Map<string, BoardNode>()

  for (const one of [...events].sort((a, b) => a.at - b.at)) {
    const was =
      nodes.get(one.node) ??
      (one.type === 'add' ? { id: one.node, title: '', summary: '', status: 'todo' as const, kind: 'feature' as const, builds_on: [], depends_on: [], at: one.at, updatedAt: one.at, commit: null } : undefined)

    if (was !== undefined) {
      nodes.set(one.node, { ...was, ...one.fields, updatedAt: one.at, commit: one.commit })
    }
  }

  return [...nodes.values()]
}

/** `n` + the local day `YYYYMMDD` + `-` + 4 random hex digits, none of `taken`. */
export function newNodeId(at: number, taken: ReadonlySet<string>): string {
  const day = dayOf(at).replace(/-/g, '')

  for (;;) {
    const id = `n${day}-${[...crypto.getRandomValues(new Uint8Array(2))].map(byte => byte.toString(16).padStart(2, '0')).join('')}`

    if (!taken.has(id)) {
      return id
    }
  }
}

/**
 * The events a call's `nodes` make against the board, or every reason it is refused: a field missing, too long or of no
 * listed value, an id the board lacks, an index past the call. `#<index>` names a node of the same call.
 */
export function planNodes(nodes: unknown, board: readonly BoardNode[], at: number, session: string, commit: string | null): { events: BoardEvent[] } | { error: string } {
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_NODES) {
    return { error: `nodes: give 1 to ${MAX_NODES} nodes, or list: true without nodes` }
  }

  const known = new Set(board.map(one => one.id))
  const taken = new Set(known)
  const ids = nodes.map(one => {
    if (isRecord(one) && typeof one.id === 'string') {
      return one.id
    }

    const id = newNodeId(at, taken)

    taken.add(id)

    return id
  })
  const errors: string[] = []
  const linked = (ref: unknown, where: string): string => {
    const index = typeof ref === 'string' ? /^#(\d+)$/.exec(ref) : null

    if (typeof ref !== 'string') {
      errors.push(`${where}: not a node id`)
    } else if (index !== null && ids[Number(index[1])] === undefined) {
      errors.push(`${where}: "${ref}" names no node of this call`)
    } else if (index === null && !known.has(ref)) {
      errors.push(`${where}: no node "${ref}" on the board`)
    }

    return index === null ? String(ref) : (ids[Number(index[1])] ?? '')
  }

  const events = nodes.map((one, i): BoardEvent => {
    const node = isRecord(one) ? one : {}
    const isUpdate = node.id !== undefined
    const path = `nodes[${i}]`
    const fields: BoardFields = {}
    const text = (key: 'title' | 'summary', max: number) => {
      const value = node[key]

      if (value === undefined && isUpdate) {
        return
      }

      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`${path}.${key}: missing`)
      } else if ([...value].length > max) {
        errors.push(`${path}.${key}: ${[...value].length} characters, at most ${max}`)
      } else {
        fields[key] = value
      }
    }
    const choice = <K extends 'status' | 'kind'>(key: K, values: readonly NonNullable<BoardFields[K]>[]) => {
      const value = node[key]

      if (value === undefined && isUpdate) {
        return
      }

      if (value === undefined) {
        errors.push(`${path}.${key}: missing`)
      } else if (!values.includes(value as NonNullable<BoardFields[K]>)) {
        errors.push(`${path}.${key}: ${JSON.stringify(value)} is not one of ${values.join(', ')}`)
      } else {
        fields[key] = value as BoardFields[K]
      }
    }

    if (isUpdate && (typeof node.id !== 'string' || !known.has(node.id))) {
      errors.push(`${path}.id: no node ${JSON.stringify(node.id)} on the board`)
    }

    text('title', TITLE_CHARS)
    text('summary', SUMMARY_CHARS)
    choice('status', STATUSES)
    choice('kind', KINDS)

    for (const key of ['builds_on', 'depends_on'] as const) {
      if (node[key] !== undefined && !Array.isArray(node[key])) {
        errors.push(`${path}.${key}: not a list`)
      }
    }

    if (Array.isArray(node.builds_on)) {
      fields.builds_on = node.builds_on.map((ref: unknown, j) => linked(ref, `${path}.builds_on[${j}]`))
    }

    if (Array.isArray(node.depends_on)) {
      fields.depends_on = node.depends_on.map((link: unknown, j): BoardLink => {
        const where = `${path}.depends_on[${j}]`

        if (!isRecord(link) || typeof link.confirmed !== 'boolean') {
          errors.push(`${where}: give { id, confirmed }`)

          return { id: '', confirmed: false }
        }

        return { id: linked(link.id, `${where}.id`), confirmed: link.confirmed }
      })
    }

    if (isUpdate && Object.keys(fields).length === 0) {
      errors.push(`${path}: nothing to update`)
    }

    return { type: isUpdate ? 'update' : 'add', node: ids[i]!, at, session, commit, fields }
  })

  return errors.length > 0 ? { error: errors.join('; ') } : { events }
}

/** The project's id in the canvas database: every character a path segment refuses becomes `-`. */
export const canvasProject = (project: string) => project.replace(/[^A-Za-z0-9_\-.~:@+]/g, '-')

/** Where the canvas mirrors a project's board: the Artifact, the project's id there and name, the call's time, and whether the nodes before it are still to mirror. */
export type CanvasSync = { url: string; project: string; name: string; at: number; isBackfill: boolean }

/**
 * The writes that mirror `events`: the project indexed anew, each event with its node's full fields, on a backfill an add per
 * other node, newest first, up to CANVAS_WRITES. Each a new doc, so none needs the version a write over an existing doc does.
 */
export function canvasWrites(events: readonly BoardEvent[], nodes: readonly BoardNode[], sync: CanvasSync) {
  const touched = new Set(events.map(one => one.node))
  // A snapshot's doc is named by this call's time: the node's own add may already be mirrored under `e<at>-<id>`.
  const doc = (type: BoardEvent['type'], { id, at, commit, title, summary, status, kind, builds_on, depends_on }: BoardNode, eventAt: number, eventCommit: string | null, isSnapshot = false) => ({
    op: 'set',
    collection: `projects/${sync.project}/events`,
    doc_id: isSnapshot ? `b${sync.at}-${id}` : `e${eventAt}-${id}`,
    data: { type, node: id, at: eventAt, commit: eventCommit, fields: { title, summary, status, kind, builds_on, depends_on } },
  })
  const own = events.flatMap(one => nodes.filter(node => node.id === one.node).map(node => doc(one.type, node, one.at, one.commit)))
  const backfill = sync.isBackfill
    ? nodes
        .filter(node => !touched.has(node.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, CANVAS_WRITES - 1 - own.length)
        .map(node => doc('add', node, node.at, node.commit, true))
    : []

  return [{ op: 'set', collection: 'projectIndex', doc_id: `${sync.project}~e${sync.at}`, data: { project: sync.project, name: sync.name } }, ...own, ...backfill]
}

/** The answer to a call that recorded: each node added or updated with its title, then the canvas batch when there is a canvas. */
export function recordedText(events: readonly BoardEvent[], nodes: readonly BoardNode[], path: string, sync: CanvasSync | null): string {
  const titleOf = (id: string) => nodes.find(one => one.id === id)?.title ?? ''

  return [
    `Recorded on the progress board (${path}):`,
    ...events.map(one => `${one.type === 'add' ? 'added' : 'updated'} ${one.node} ${titleOf(one.node)}`),
    ...(sync === null
      ? []
      : [
          `Mirror it to the progress canvas with one ArtifactData call: action "batch", url ${sync.url}, writes:`,
          '```json',
          JSON.stringify(canvasWrites(events, nodes, sync)),
          '```',
        ]),
  ].join('\n')
}

/** The answer to `list: true`: the most recently changed nodes first. */
export function listText(nodes: readonly BoardNode[]): string {
  const recent = [...nodes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LISTED_NODES)

  if (recent.length === 0) {
    return 'The progress board has no nodes yet.'
  }

  return ['Recent nodes (id · title · status · kind · date):', ...recent.map(one => [one.id, one.title, one.status, one.kind, dayOf(one.updatedAt)].join(' · '))].join('\n')
}

/** The answer while the project has not chosen where its board lives. */
export function storageQuestion(project: string, root: string): string {
  return [
    'Nothing recorded: this project has not chosen where to keep its progress board.',
    'Ask the person with AskUserQuestion, then call progress again with the same input and storage set to their answer:',
    `- local: ${boardDir('~', project)}/events/, private to this machine`,
    `- git: ${root}/.notes/board/events/, committed with the project`,
  ].join('\n')
}
