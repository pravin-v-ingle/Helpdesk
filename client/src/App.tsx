import { Navigate, Route, Routes } from 'react-router'
import { ProtectedRoute } from './auth/ProtectedRoute.tsx'
import { RequireRole } from './auth/RequireRole.tsx'
import { AppLayout } from './components/AppLayout.tsx'
import { Role } from './lib/api.ts'
import { HomePage } from './pages/HomePage.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { TicketDetailPage } from './pages/TicketDetailPage.tsx'
import { TicketsPage } from './pages/TicketsPage.tsx'
import { UsersPage } from './pages/UsersPage.tsx'

/**
 * The route table. `/`, `/tickets` and `/tickets/:id` sit in the same AppLayout
 * branch, so they get the nav bar and the session gate for free. Admin-only
 * routes nest one level further, under `RequireRole` - which the two ticket
 * routes deliberately do not, because working tickets is the agent's job.
 */
function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/tickets" element={<TicketsPage />} />
          <Route path="/tickets/:id" element={<TicketDetailPage />} />

          <Route element={<RequireRole role={Role.ADMIN} />}>
            <Route path="/users" element={<UsersPage />} />
          </Route>
        </Route>
      </Route>

      {/* Unknown paths fall through to the home page, which redirects to the
          login page when there is no session. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
