import { Outlet } from 'react-router'
import { NavBar } from './NavBar.tsx'

/** The signed-in shell: nav bar above, routed page below. */
export function AppLayout() {
  return (
    <>
      <NavBar />
      <Outlet />
    </>
  )
}
