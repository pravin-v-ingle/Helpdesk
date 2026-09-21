import { Navigate, Route, Routes } from 'react-router'
import { ProtectedRoute } from './auth/ProtectedRoute.tsx'
import { RequireRole } from './auth/RequireRole.tsx'
import { AppLayout } from './components/AppLayout.tsx'
import { Role } from './lib/api.ts'
import { HomePage } from './pages/HomePage.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { UsersPage } from './pages/UsersPage.tsx'

/**
 * The route table. Later routes - `/tickets`, `/tickets/:id` - nest inside
 * the same AppLayout branch, so they get the nav bar and the session gate for
 * free. Admin-only routes nest one level further, under `RequireRole`.
 */
function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomePage />} />

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
