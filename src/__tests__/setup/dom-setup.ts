/**
 * DOM-test setup for the form-component suites.
 *
 * Forces RTL's `cleanup()` between tests so each `render(...)` starts
 * from a fresh DOM. Vitest does not auto-detect `globals: true` here,
 * which is what `@testing-library/react`'s built-in cleanup hook
 * relies on, so we wire it up explicitly.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
