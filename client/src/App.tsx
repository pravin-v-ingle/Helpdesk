import { useEffect, useState } from 'react'
import './App.css'

type Health = {
  status: string
  uptime: number
  timestamp: string
}

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; health: Health }
  | { kind: 'error'; message: string }

function App() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()

    fetch('/api/health', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`)
        return (await res.json()) as Health
      })
      .then((health) => setState({ kind: 'ok', health }))
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return
        setState({ kind: 'error', message: String(err) })
      })

    return () => controller.abort()
  }, [])

  return (
    <main>
      <h1>Helpdesk</h1>
      <p>AI-powered ticket management system</p>

      <section>
        <h2>API connection</h2>
        {state.kind === 'loading' && <p>Checking…</p>}
        {state.kind === 'error' && (
          <p>
            Could not reach the API: {state.message}
            <br />
            Is the server running on port 3000?
          </p>
        )}
        {state.kind === 'ok' && (
          <p>
            Connected. Status <strong>{state.health.status}</strong>, up for{' '}
            {Math.round(state.health.uptime)}s.
          </p>
        )}
      </section>
    </main>
  )
}

export default App
