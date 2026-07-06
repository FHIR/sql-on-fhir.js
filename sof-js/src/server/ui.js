// Escape a value for safe interpolation into HTML text/attributes.
export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  )
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
