import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Unmount everything between tests. Automatic only when Vitest globals are on.
afterEach(() => cleanup())

// jsdom does not implement the pointer-capture and layout APIs Radix
// primitives call when a Select opens. Stubbing them is enough: the
// components only need the calls not to throw.
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.scrollIntoView ??= () => {}

globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
