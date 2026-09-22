// Escape a value for safe interpolation into HTML text/attributes.
export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  )
}

// Shared form control classes.
export const FORM_INPUT = 'border border-gray-300 rounded p-2 w-full'

// A labelled form field: bold label, optional muted hint, and a control.
export function formField(label, hint, control) {
  return `
  <div>
    <label class="block font-semibold mb-1">${label}${
      hint ? ` <span class="text-gray-400 font-normal text-sm">${hint}</span>` : ''
    }</label>
    ${control}
  </div>`
}

// A section legend inside a <fieldset>.
export function legend(text) {
  return `<legend class="text-sm font-semibold text-gray-500 uppercase tracking-wide">${text}</legend>`
}

// A page header row: title (left) with optional action buttons (right).
export function pageHeader(title, actions = '') {
  return `
    <div class="mt-4 flex flex-wrap items-center gap-2 border-b border-gray-200 pb-2">
      <h1 class="flex-1 text-2xl font-bold">${title}</h1>
      ${actions}
    </div>`
}

// A pretty-printed JSON block for resource detail pages.
export function jsonBlock(obj) {
  return `<pre class="mt-4 bg-gray-100 p-4 rounded-md text-xs overflow-x-auto">${escapeHtml(
    JSON.stringify(obj, null, 2),
  )}</pre>`
}

// The empty-state box used by list pages.
export function emptyState(message) {
  return `<div class="mt-6 border border-dashed border-gray-300 rounded-md p-8 text-center text-gray-500">${message}</div>`
}

// A standard page shell: a centered container with a breadcrumb.
export function page(crumbs, body, { width = 'max-w-4xl' } = {}) {
  return layout(`
    <div class="container mx-auto p-4 ${width}">
      ${breadcrumb(...crumbs)}
      ${body}
    </div>`)
}

// A "/"-separated breadcrumb trail rooted at Home. Pass pre-rendered segments.
export function breadcrumb(...parts) {
  return `<div class="flex gap-2 items-center text-sm">${[
    '<a href="/" class="text-blue-500 hover:text-blue-700">Home</a>',
    ...parts,
  ].join('<span class="text-gray-400">/</span>')}</div>`
}

// The shared "table/relation" glyph used by list rows and cards.
const TABLE_ICON_PATH =
  'M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm6.5.75v3h3v-3Zm3 4.5h-3v3h3Zm1.5 3h3v-3h-3Zm3-4.5v-3h-3v3Zm-9-3h-3v3h3Zm-3 4.5v3h3v-3Z'
export function tableIcon(cls = 'w-4 h-4 text-gray-400 shrink-0') {
  return `<svg class="${cls}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="${TABLE_ICON_PATH}"/></svg>`
}

const STATUS_STYLES = {
  ready: 'bg-green-100 text-green-800',
  building: 'bg-blue-100 text-blue-800',
  requested: 'bg-gray-100 text-gray-700',
  stale: 'bg-amber-100 text-amber-800',
  failed: 'bg-red-100 text-red-800',
}

export function statusPill(status) {
  const cls = STATUS_STYLES[status] || 'bg-gray-100 text-gray-700'
  return `<span class="px-2 py-0.5 rounded-full text-xs font-medium ${cls}">${escapeHtml(status || 'unknown')}</span>`
}

// A titled list section: a badge + item count over a bordered <ul>. `rowFn`
// renders each item to an <li>.
export function listSection(badge, items, noun, rowFn) {
  const plural = items.length === 1 ? noun : noun.endsWith('y') ? noun.slice(0, -1) + 'ies' : noun + 's'
  return `
    <section class="mt-6">
      <div class="flex items-center gap-2 mb-2">
        <span class="px-2 py-0.5 rounded bg-slate-100 font-mono text-sm font-semibold">${escapeHtml(badge)}</span>
        <span class="text-gray-400 text-sm">${items.length} ${plural}</span>
      </div>
      <ul class="border border-gray-200 rounded-md divide-y divide-gray-200 overflow-hidden">
        ${items.map(rowFn).join('')}
      </ul>
    </section>`
}

// Render an array of flat row objects as an HTML table.
export function rowsTable(rows, { emptyText = 'No rows.' } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return `<p class="mt-2 text-sm text-gray-500">${escapeHtml(emptyText)}</p>`
  }
  const cols = Object.keys(rows[0])
  const head = cols
    .map((c) => `<th class="bg-gray-100 border border-gray-200 p-2 text-left">${escapeHtml(c)}</th>`)
    .join('')
  const body = rows
    .map(
      (r) =>
        `<tr>${cols
          .map((c) => {
            const v = r[c]
            const cell =
              v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
            return `<td class="border border-gray-200 p-2 text-sm">${escapeHtml(cell)}</td>`
          })
          .join('')}</tr>`,
    )
    .join('')
  return `
    <div class="mt-2 overflow-x-auto">
      <table class="table-auto border-collapse border border-gray-200 w-full">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`
}

export function layout(content) {
  return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SQL on FHIR</title>
        <script src="/htmx.js"></script>
        <script src="/app.js"></script>
        <link href="/app.build.css" rel="stylesheet"></link>
      </head>
      <body>
        ${content}
      </body>
      </html>
    `
}
