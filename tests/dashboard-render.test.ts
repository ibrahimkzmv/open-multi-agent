import { describe, expect, it } from 'vitest'
import { renderTeamRunDashboard } from '../src/dashboard/render-team-run-dashboard.js'

describe('renderTeamRunDashboard', () => {
  it('does not embed unescaped script terminators in the JSON payload and keeps XSS payloads out of HTML markup', () => {
    const malicious = '"</script><img src=x onerror=alert(1)>"'
    const html = renderTeamRunDashboard({
      success: true,
      goal: 'safe-goal',
      tasks: [
        {
          id: 't1',
          title: malicious,
          status: 'pending',
          dependsOn: [],
        },
      ],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    })

    const dataOpen = 'id="oma-data">'
    const start = html.indexOf(dataOpen)
    expect(start).toBeGreaterThan(-1)
    const contentStart = start + dataOpen.length
    const end = html.indexOf('</script>', contentStart)
    expect(end).toBeGreaterThan(contentStart)
    const jsonSlice = html.slice(contentStart, end)
    expect(jsonSlice.toLowerCase()).not.toContain('</script')

    const parsed = JSON.parse(jsonSlice) as { tasks: { title: string }[] }
    expect(parsed.tasks[0]!.title).toBe(malicious)

    const beforeData = html.slice(0, start)
    expect(beforeData).not.toContain(malicious)
    expect(beforeData.toLowerCase()).not.toMatch(/\sonerror\s*=/)
  })
})
