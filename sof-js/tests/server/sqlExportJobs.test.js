/**
 * Unit tests for `$sql-export` job persistence: recovery of jobs interrupted by
 * a restart and the manifest built from a completed job.
 *
 * Author: John Grimes
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { recoverJobs, manifest } from '../../src/server/sqlExport.js'

function writeJob(exportDir, job) {
  fs.mkdirSync(path.join(exportDir, job.exportId), { recursive: true })
  fs.writeFileSync(path.join(exportDir, job.exportId, 'job.json'), JSON.stringify(job))
}

function readJob(exportDir, exportId) {
  return JSON.parse(fs.readFileSync(path.join(exportDir, exportId, 'job.json'), 'utf8'))
}

describe('recoverJobs', () => {
  test('marks accepted and in-progress jobs failed and leaves finished jobs alone', () => {
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sof-jobs-'))
    writeJob(exportDir, { exportId: 'a', status: 'accepted' })
    writeJob(exportDir, { exportId: 'b', status: 'in-progress' })
    writeJob(exportDir, { exportId: 'c', status: 'completed' })
    writeJob(exportDir, { exportId: 'd', status: 'cancelled' })

    recoverJobs({ exportDir })

    expect(readJob(exportDir, 'a').status).toBe('failed')
    expect(readJob(exportDir, 'b').status).toBe('failed')
    expect(readJob(exportDir, 'b').error.issues[0].code).toBe('exception')
    expect(readJob(exportDir, 'c').status).toBe('completed')
    expect(readJob(exportDir, 'd').status).toBe('cancelled')
    fs.rmSync(exportDir, { recursive: true, force: true })
  })

  test('tolerates a missing export directory', () => {
    expect(() =>
      recoverJobs({ exportDir: path.join(os.tmpdir(), 'does-not-exist-' + Date.now()) }),
    ).not.toThrow()
  })
})

describe('manifest', () => {
  test('carries identity, metadata and one output per subject with absolute download URLs', () => {
    const job = {
      exportId: 'x',
      clientTrackingId: 'track',
      status: 'completed',
      format: 'csv',
      baseUrl: 'http://host',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:01:15.000Z',
      subjects: [{ name: 'a' }, { name: 'b' }],
      outputs: [
        { name: 'a', file: 'a.csv' },
        { name: 'b', file: 'b.csv' },
      ],
    }
    const m = manifest(job)
    const byName = Object.fromEntries(m.parameter.filter((p) => p.name !== 'output').map((p) => [p.name, p]))
    expect(byName.exportId.valueString).toBe('x')
    expect(byName.clientTrackingId.valueString).toBe('track')
    expect(byName.status.valueCode).toBe('completed')
    expect(byName._format.valueCode).toBe('csv')
    expect(byName.exportDuration.valueInteger).toBe(75)
    const outputs = m.parameter.filter((p) => p.name === 'output')
    expect(outputs.map((o) => o.part[1].valueUri)).toEqual([
      'http://host/$sql-export/x/a.csv',
      'http://host/$sql-export/x/b.csv',
    ])
  })
})
