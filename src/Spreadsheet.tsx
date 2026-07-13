import { useState, useCallback, useRef, useEffect, useMemo, type KeyboardEvent } from 'react'
import './Spreadsheet.css'
import { evaluateCode, newRuntime } from './Lang'
import { openSpace, type Space, type Peer } from './inc/automerge-kiss'

const ROWS = 50
const COLS = 26

export type CellAddress = { row: number; col: number }
export type CellValue = { raw: string; computed?: string }
export type CellData = Record<string, CellValue>
type SpaceDoc = { cells: Record<string, string> }

function colLabel(n: number): string {
  let label = ''
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  }
  return label
}

export function cellKey(row: number, col: number) {
  return `${row},${col}`
}

export function colNameToIndex(name: string): number {
  let index = 0
  for (let i = 0; i < name.length; i++) {
    index = index * 26 + (name.charCodeAt(i) - 64)
  }
  return index - 1
}

export function parseCellAddress(address: string): CellAddress {
  const match = address.match(/^([A-Z]+)([0-9]+)$/)
  if (!match) throw new Error(`Invalid cell address: ${address}`)
  return { col: colNameToIndex(match[1]), row: parseInt(match[2], 10) - 1 }
}

async function evaluateAll(data: CellData): Promise<CellData> {
  const next: CellData = {}
  const runtime = newRuntime()

  for (const key of Object.keys(data)) {
    next[key] = { ...data[key], computed: undefined }
  }

  for (const key of Object.keys(next)) {
    const { raw } = next[key]
    if (!raw.startsWith('=')) continue
    runtime.stack = []
    try {
      evaluateCode(raw.slice(1), next, runtime)
      next[key] = { ...next[key], computed: String(runtime.pop().data) }
    } catch (e) {
      console.error(`Error evaluating cell ${key}:`, e)
      next[key] = { ...next[key], computed: '#ERROR' }
    }
  }

  return next
}

// Only apply computed values where the raw value still matches the snapshot (guards async races)
function mergeComputed(prev: CellData, snapshot: CellData): CellData {
  const next = { ...prev }
  for (const [key, cell] of Object.entries(snapshot)) {
    if (next[key] && next[key].raw === cell.raw && cell.computed !== undefined) {
      next[key] = { ...next[key], computed: cell.computed }
    }
  }
  return next
}

// Build React CellData from a space doc, preserving computed for unchanged raws
function spaceDocToData(doc: SpaceDoc, prev: CellData): CellData {
  const cells = doc.cells ?? {}
  const next: CellData = {}
  for (const [key, raw] of Object.entries(cells)) {
    const existing = prev[key]
    next[key] = { raw, computed: existing?.raw === raw ? existing.computed : undefined }
  }
  return next
}

function applyEdit(data: CellData, row: number, col: number, value: string): CellData {
  const next = { ...data }
  if (value === '') delete next[cellKey(row, col)]
  else next[cellKey(row, col)] = { raw: value, computed: undefined }
  return next
}

function adjustFormula(raw: string, dRow: number, dCol: number): string {
  if (!raw.startsWith('=')) return raw
  return '=' + raw.slice(1).replace(/([A-Z]+)(\d+)/g, (match, col, row) => {
    const newRow = parseInt(row, 10) + dRow
    const newCol = colNameToIndex(col) + dCol
    if (newRow < 1 || newCol < 0 || newCol >= COLS) return match
    return colLabel(newCol) + newRow
  })
}

function applyFill(data: CellData, start: CellAddress, end: CellAddress): CellData {
  const next = { ...data }
  const sourceRaw = data[cellKey(start.row, start.col)]?.raw ?? ''
  const r0 = Math.min(start.row, end.row), r1 = Math.max(start.row, end.row)
  const c0 = Math.min(start.col, end.col), c1 = Math.max(start.col, end.col)
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (r === start.row && c === start.col) continue
      const value = adjustFormula(sourceRaw, r - start.row, c - start.col)
      if (value === '') delete next[cellKey(r, c)]
      else next[cellKey(r, c)] = { raw: value, computed: undefined }
    }
  }
  return next
}

function peerHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

function inFillRange(r: number, c: number, drag: { start: CellAddress; end: CellAddress }): boolean {
  const r0 = Math.min(drag.start.row, drag.end.row), r1 = Math.max(drag.start.row, drag.end.row)
  const c0 = Math.min(drag.start.col, drag.end.col), c1 = Math.max(drag.start.col, drag.end.col)
  return r >= r0 && r <= r1 && c >= c0 && c <= c1
}

export default function Spreadsheet() {
  const [data, setData] = useState<CellData>({})
  const [autoEval, setAutoEval] = useState(true)
  const [selected, setSelected] = useState<CellAddress>({ row: 0, col: 0 })
  const [editing, setEditing] = useState<CellAddress | null>(null)
  const [editValue, setEditValue] = useState('')
  const [fillDrag, setFillDrag] = useState<{ start: CellAddress; end: CellAddress } | null>(null)
  const [spaceStatus, setSpaceStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [peers, setPeers] = useState<Peer[]>([])
  const [ownPeerId, setOwnPeerId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [highlightedCells, setHighlightedCells] = useState<Set<string>>(new Set())

  const inputRef = useRef<HTMLInputElement>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const fillDragRef = useRef(fillDrag)
  fillDragRef.current = fillDrag
  const autoEvalRef = useRef(autoEval)
  autoEvalRef.current = autoEval
  const dataRef = useRef(data)
  dataRef.current = data
  const spaceRef = useRef<Space<SpaceDoc> | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  // Init automerge space — replaces localStorage
  useEffect(() => {
    let cancelled = false
    let s: Space<SpaceDoc> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    openSpace<SpaceDoc>({ starter: { cells: {} }, remember: 'forth-sheet' })
      .then(opened => {
        // StrictMode double-invokes effects; if cleanup already ran, close
        // the space we just opened so it doesn't become a ghost peer.
        if (cancelled) { opened.leave(); return }
        s = opened
        spaceRef.current = s
        setOwnPeerId(s.peerId)
        setSpaceStatus('ready')
        s.onChange(doc => {
          const newData = spaceDocToData(doc, dataRef.current)
          setData(newData)
          if (autoEvalRef.current) {
            evaluateAll(newData).then(snap => setData(prev => mergeComputed(prev, snap)))
          }
        })
        s.onPeers(setPeers)
        // Re-broadcast presence every 3 s so peers don't time us out (library evicts after 6 s)
        heartbeat = setInterval(() => {
          const { row, col } = selectedRef.current
          s?.setPresence({ row, col })
        }, 3000)
      })
      .catch(err => {
        if (cancelled) return
        console.error('[forth-sheet] Failed to open space:', err)
        setSpaceStatus('error')
      })
    return () => {
      cancelled = true
      clearInterval(heartbeat)
      s?.leave()
      spaceRef.current = null
    }
  }, [])

  // Broadcast our cursor position to other peers
  useEffect(() => {
    spaceRef.current?.setPresence({ row: selected.row, col: selected.col })
  }, [selected, spaceStatus])

  // Derive a cellKey→color map from peers' presence data.
  // The library already gives one entry per peer ID, so each peer occupies
  // exactly one cell. Filter own echo so it never shows as a "peer highlight".
  const peerCells = useMemo(() => {
    const map: Record<string, string> = {}
    for (const peer of peers) {
      if (peer.id === ownPeerId) continue
      const p = peer.presence as { row?: number; col?: number } | null
      if (p && typeof p.row === 'number' && typeof p.col === 'number') {
        map[cellKey(p.row, p.col)] = `hsla(${peerHue(peer.id)}, 70%, 55%, 0.18)`
      }
    }
    return map
  }, [peers, ownPeerId])

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  useEffect(() => {
    document.body.style.cursor = fillDrag ? 'crosshair' : ''
    document.body.style.userSelect = fillDrag ? 'none' : ''
  }, [fillDrag !== null])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onMouseUp = () => {
      const drag = fillDragRef.current
      if (!drag) return
      if (drag.start.row !== drag.end.row || drag.start.col !== drag.end.col) {
        const next = applyFill(dataRef.current, drag.start, drag.end)
        const r0 = Math.min(drag.start.row, drag.end.row), r1 = Math.max(drag.start.row, drag.end.row)
        const c0 = Math.min(drag.start.col, drag.end.col), c1 = Math.max(drag.start.col, drag.end.col)
        spaceRef.current?.update(draft => {
          for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
              if (r === drag.start.row && c === drag.start.col) continue
              const key = cellKey(r, c)
              const value = next[key]?.raw ?? ''
              if (value === '') delete draft.cells[key]
              else draft.cells[key] = value
            }
          }
        })
        if (autoEvalRef.current) evaluateAll(next).then(snap => setData(prev => mergeComputed(prev, snap)))
      }
      setFillDrag(null)
    }
    document.addEventListener('mouseup', onMouseUp)
    return () => document.removeEventListener('mouseup', onMouseUp)
  }, [])

  const selectedLabel = `${colLabel(selected.col)}${selected.row + 1}`
  const getRaw = (row: number, col: number) => data[cellKey(row, col)]?.raw ?? ''
  const getDisplay = (row: number, col: number) => {
    const cell = data[cellKey(row, col)]
    return cell?.computed ?? cell?.raw ?? ''
  }

  const commitEdit = useCallback((row: number, col: number, value: string) => {
    spaceRef.current?.update(draft => {
      if (value === '') delete draft.cells[cellKey(row, col)]
      else draft.cells[cellKey(row, col)] = value
    })
    setEditing(null)
  }, [])

  const handleEvaluate = async () => {
    const snap = await evaluateAll(dataRef.current)
    setData(prev => mergeComputed(prev, snap))
    tableRef.current?.focus()
  }

  const handleShare = async () => {
    const url = spaceRef.current?.shareUrl ?? location.href
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const startEditing = (row: number, col: number, initialValue?: string) => {
    setEditing({ row, col })
    setEditValue(initialValue !== undefined ? initialValue : getRaw(row, col))
  }

  const moveSelection = (dRow: number, dCol: number) => {
    setSelected(prev => ({
      row: Math.max(0, Math.min(ROWS - 1, prev.row + dRow)),
      col: Math.max(0, Math.min(COLS - 1, prev.col + dCol)),
    }))
  }

  const handleCellKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault(); startEditing(selected.row, selected.col); return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      spaceRef.current?.update(draft => { delete draft.cells[cellKey(selected.row, selected.col)] })
      return
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1, 0); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1, 0); return }
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveSelection(0, -1); return }
    if (e.key === 'ArrowRight') { e.preventDefault(); moveSelection(0, 1); return }
    if (e.key === 'Tab') { e.preventDefault(); moveSelection(0, e.shiftKey ? -1 : 1); return }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); startEditing(selected.row, selected.col, e.key)
    }
  }

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (!editing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      const { row, col } = editing
      const value = editValue
      spaceRef.current?.update(draft => {
        if (value === '') delete draft.cells[cellKey(row, col)]
        else draft.cells[cellKey(row, col)] = value
      })
      setEditing(null)
      if (autoEval) {
        const newData = applyEdit(dataRef.current, row, col, value)
        evaluateAll(newData).then(snap => setData(prev => mergeComputed(prev, snap)))
      }
      moveSelection(1, 0)
      tableRef.current?.focus()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      commitEdit(editing.row, editing.col, editValue)
      moveSelection(0, e.shiftKey ? -1 : 1)
      tableRef.current?.focus()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault(); setEditing(null); tableRef.current?.focus(); return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      commitEdit(editing.row, editing.col, editValue)
      moveSelection(e.key === 'ArrowUp' ? -1 : 1, 0)
      tableRef.current?.focus()
      return
    }
  }

  const selectedRaw = editing ? editValue : getRaw(selected.row, selected.col)

  const highlight_regex = /([A-Z]+[0-9]+)/g

  useEffect(() => {
    const raw = getRaw(selected.row, selected.col)
    if (!raw.startsWith('=')) {
      setHighlightedCells(new Set())
      return
    }
    const matches = raw.matchAll(highlight_regex)
    // console.log(`Highlighting matches for ${raw}:`, Array.from(matches))
    const newHighlighted = new Set<string>()
    for (const match of matches) {
      const addr = match[0]
      // console.log(`Found address in formula: ${addr}`)
      try {
        const { row, col } = parseCellAddress(addr)
        newHighlighted.add(cellKey(row, col))
      }
      catch (e) {
        console.error(`Invalid cell address in formula: ${addr}`)
      }
    }
    console.log(`Setting highlighted cells for ${raw}:`, newHighlighted)
    setHighlightedCells(newHighlighted)
  }, [selected])

  const hasComputed = (row: number, col: number) => data[cellKey(row, col)]?.computed !== undefined

  const safeCellKey = (addr: string) => {
    try {
      const { row, col } = parseCellAddress(addr)
      return cellKey(row, col)
    } catch (e) {
      return null
    }
  }

  return (
    <div className="sheet-root">
      <div className="formula-bar">
        <span className="cell-address">{selectedLabel}</span>
        <div className="formula-bar-divider" />

        <span className="formula-value">{selectedRaw.split(" ").map((s: string, i: number) => <span key={`${s}-${i}`} style={{ color: highlightedCells.has(safeCellKey(s)) ? `hsl(${(parseCellAddress(s).row * COLS + parseCellAddress(s).col) * 137.5 % 360}, 70%, 50%)` : 'black' }}>{s}&nbsp;</span>)}</span>
        <label className="auto-eval-label">
          <input type="checkbox" checked={autoEval} onChange={e => setAutoEval(e.target.checked)} />
          Auto-eval on Enter
        </label>
        <button className="evaluate-btn" onClick={handleEvaluate}>Evaluate</button>
        <div className="formula-bar-divider" />
        <div className="space-status">
          {spaceStatus === 'loading' && <span className="space-indicator space-connecting">Connecting…</span>}
          {spaceStatus === 'error' && <span className="space-indicator space-error">⚠ Sync error</span>}
          {spaceStatus === 'ready' && (
            <span className="space-indicator space-ready">
              {peers.length > 0 ? `● ${peers.length} other${peers.length !== 1 ? 's' : ''}` : '● Live'}
            </span>
          )}
        </div>
        <button
          className="share-btn"
          onClick={handleShare}
          disabled={spaceStatus !== 'ready'}
          title="Copy shareable link to clipboard"
        >
          {copied ? '✓ Copied' : 'Copy link'}
        </button>
      </div>

      <div className="sheet-scroll" ref={tableRef} tabIndex={0} onKeyDown={handleCellKeyDown}>
        {spaceStatus === 'loading' && (
          <div className="sheet-overlay">
            <span className="sheet-overlay-msg">Connecting to sync space…</span>
          </div>
        )}
        <table className="sheet-table">
          <thead>
            <tr>
              <th className="corner-cell" />
              {Array.from({ length: COLS }, (_, c) => (
                <th key={c} className={`col-header${selected.col === c ? ' active' : ''}`}>
                  {colLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: ROWS }, (_, r) => (
              <tr key={r}>
                <td className={`row-header${selected.row === r ? ' active' : ''}`}>{r + 1}</td>
                {Array.from({ length: COLS }, (_, c) => {
                  const isSelected = selected.row === r && selected.col === c
                  const isEditing = editing?.row === r && editing?.col === c
                  const isFormula = hasComputed(r, c)
                  const isFillTarget = fillDrag !== null && inFillRange(r, c, fillDrag)
                  const isHighlighted = highlightedCells.has(cellKey(r, c))
                  const peerColor = peerCells[cellKey(r, c)]
                  return (
                    <td
                      key={c}
                      className={`cell${isSelected ? ' selected' : ''}${isFormula ? ' has-computed' : ''}${isFillTarget ? ' fill-range' : ''}`}
                      style={peerColor && !isSelected ? { backgroundColor: peerColor } : undefined}
                      onClick={() => {
                        setSelected({ row: r, col: c })
                        tableRef.current?.focus()
                      }}
                      onDoubleClick={() => startEditing(r, c)}
                      onMouseEnter={() => {
                        if (fillDragRef.current) setFillDrag(prev => prev ? { ...prev, end: { row: r, col: c } } : null)
                      }}

                    >
                      {isEditing ? (
                        <input
                          ref={inputRef}
                          className="cell-input"
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onKeyDown={handleInputKeyDown}
                          onBlur={() => commitEdit(r, c, editValue)}
                        />
                      ) : (
                        <span className="cell-value">{getDisplay(r, c)}</span>
                      )}
                      {isSelected && !editing && (
                        <div
                          className="fill-handle"
                          onMouseDown={e => {
                            e.preventDefault(); e.stopPropagation()
                            setFillDrag({ start: { row: r, col: c }, end: { row: r, col: c } })
                          }}
                          onClick={e => e.stopPropagation()}
                        />
                      )}
                      {isHighlighted && (
                        <div
                          className="highlight-border"
                          style={{ borderColor: `hsl(${(r * COLS + c) * 137.5 % 360}, 70%, 50%)` }}
                        />
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
