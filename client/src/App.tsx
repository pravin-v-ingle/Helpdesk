import { Navigate, Route, Routes } from 'react-router'
import { ProtectedRoute } from './auth/ProtectedRoute.tsx'
import { RequireRole } from './auth/RequireRole.tsx'
import { AppLayout } from './components/AppLayout.tsx'
import { Role } from './lib/api.ts'
import { HomePage } from './pages/HomePage.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { TicketsPage } from './pages/TicketsPage.tsx'
import { UsersPage } from './pages/UsersPage.tsx'

/**
 * The route table. `/tickets` and `/` sit in the same AppLayout branch, so they
 * get the nav bar and the session gate for free; `/tickets/:id` joins them when
 * the detail page lands. Admin-only routes nest one level further, under
 * `RequireRole` - which `/tickets` deliberately does not, because working
 * tickets is the agent's job.
 */
function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/tickets" element={<TicketsPage />} />

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
