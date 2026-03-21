# UI Architecture

This document establishes the frontend architecture for aice-web-next before implementation begins. It is separate from `ARCHITECTURE.md`, which covers the BFF/mTLS backend layer (see Issue #1).

Designs are based on the Figma files "Ready for Development Light" and "Ready for Development Dark".

---

## Table of Contents

1. [Tech Stack](#1-tech-stack)
2. [Design Token System](#2-design-token-system)
3. [Theme Strategy](#3-theme-strategy)
4. [Responsive Strategy](#4-responsive-strategy)
5. [Directory Structure](#5-directory-structure)
6. [Layout Architecture](#6-layout-architecture)
7. [shadcn/ui Setup](#7-shadcnui-setup)
8. [Page UI Requirements](#8-page-ui-requirements)
9. [Internationalization](#9-internationalization)
10. [Accessibility](#10-accessibility)
11. [Out of Scope](#11-out-of-scope)
12. [Additional Packages](#12-additional-packages)

---

## 1. Tech Stack

| Item | Choice | Rationale |
|------|--------|-----------|
| UI components | shadcn/ui (new-york style) | Official Tailwind v4 support, accessibility, customizable |
| Styling | Tailwind CSS v4 | Already installed, CSS-first config |
| Animation | tw-animate-css | tailwindcss-animate deprecated in v4 |
| Forms | React Hook Form 7.x + Zod v4 + @hookform/resolvers | Decided in Issue #1 |
| Server state | TanStack Query v5 | Decided in Issue #1 |
| Font | Roboto (Google Fonts) | Matches Figma design; replaces current Geist |
| Icons | lucide-react | shadcn/ui default icon set |
| Theming | `data-theme` attribute on `<html>` | Extensible to N themes; CSS-variable-first |
| Theme SSR | next-themes (`attribute="data-theme"`) | Prevents hydration mismatch |
| Initial themes | `gray-light`, `gray-dark` | Current Figma palette; `gray` = palette name, `light`/`dark` = brightness |

---

## 2. Design Token System

Tokens are extracted from the Figma "Ready for Development" files.

### 2.1 Color Tokens

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--bg-canvas` | `#f5f6f7` | `#1a1d20` | Page background |
| `--card-bg` | `#ffffff` | `rgba(97, 105, 116, 0.08)` | Card background |
| `--control-bg` | `rgba(97, 105, 116, 0.08)` | `rgba(97, 105, 116, 0.24)` | Input background |
| `--control-placeholder` | `#616974` | `#616974` | Placeholder text |
| `--text-primary` | `#212428` | `#fafafa` | Primary text |
| `--text-secondary` | `#474c55` | `#b4bbc6` | Secondary text |
| `--btn-primary-bg` | `#156ef2` | `#156ef2` | Primary button (same across themes) |
| `--btn-primary-bg-disabled` | `#c5e4f7` | TBD | Disabled button |
| `--btn-primary-fg` | `#ffffff` | `#ffffff` | Button text |
| `--danger` | `#db1d03` | `#fb2c10` | Error / required indicator |
| `--neutral-40` | `#7c8492` | `#7c8492` | Secondary icons |
| `--neutral-30` | -- | `#8e97a5` | Dark-only neutral |

### 2.2 Typography Tokens

| Token | Value | Usage |
|-------|-------|-------|
| Font family | Roboto | All text |
| Heading | Bold 20px / line-height 25px | Page and card titles |
| Label | Medium 16px / line-height 24px | Form labels, buttons |
| Body | Regular 16px / line-height 24px | General text |

### 2.3 Component Dimensions

| Item | Value |
|------|-------|
| Card border-radius | 6px |
| Input border-radius | 8px |
| Button border-radius | 8px |
| Button height | 40px |
| Input height (with label) | 68px |
| Card shadow | `0 10px 10px rgba(0,0,0,0.04), 0 20px 25px rgba(0,0,0,0.01)` |
| Sidebar expanded | 256px |
| Sidebar collapsed | 64px |

### 2.4 globals.css Structure

**Design principle**: Components only reference CSS custom properties, never hardcoded color values. Adding a new theme requires only a new `[data-theme="name"]` block in `globals.css` -- no component changes needed.

Top-level imports:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap');
```

Base tokens shared across all themes, plus the complete shadcn/ui semantic alias set. Values marked `TBD` must be confirmed against Figma before implementation; suggested defaults are derived from the extracted palette.

```css
:root {
  --radius: 6px;
  --btn-primary-bg: #156ef2;
  --btn-primary-fg: #ffffff;

  /* shadcn/ui semantic aliases -- complete set */
  --background:             var(--bg-canvas);
  --foreground:             var(--text-primary);
  --card:                   var(--card-bg);
  --card-foreground:        var(--text-primary);
  --popover:                var(--card-bg);
  --popover-foreground:     var(--text-primary);
  --primary:                var(--btn-primary-bg);
  --primary-foreground:     var(--btn-primary-fg);
  --secondary:              var(--control-bg);         /* TBD Figma */
  --secondary-foreground:   var(--text-primary);
  --muted:                  var(--control-bg);
  --muted-foreground:       var(--text-secondary);
  --accent:                 var(--control-bg);         /* TBD Figma */
  --accent-foreground:      var(--text-primary);
  --destructive:            var(--danger);
  --destructive-foreground: #ffffff;
  --border:                 rgba(97, 105, 116, 0.16);  /* TBD Figma */
  --input:                  var(--control-bg);
  --ring:                   var(--btn-primary-bg);
}
```

`gray-light` theme (shipped with initial release):

```css
[data-theme="gray-light"] {
  --bg-canvas: #f5f6f7;
  --card-bg: #ffffff;
  --control-bg: rgba(97, 105, 116, 0.08);
  --control-placeholder: #616974;
  --text-primary: #212428;
  --text-secondary: #474c55;
  --btn-primary-bg-disabled: #c5e4f7;
  --danger: #db1d03;
  --neutral-40: #7c8492;
}
```

`gray-dark` theme (shipped with initial release):

```css
[data-theme="gray-dark"] {
  --bg-canvas: #1a1d20;
  --card-bg: rgba(97, 105, 116, 0.08);
  --control-bg: rgba(97, 105, 116, 0.24);
  --control-placeholder: #616974;
  --text-primary: #fafafa;
  --text-secondary: #b4bbc6;
  --danger: #fb2c10;
  --neutral-30: #8e97a5;
  --neutral-40: #7c8492;
}
```

Tailwind v4 `@theme` mapping and dark variant:

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-destructive: var(--destructive);
  --font-sans: 'Roboto', sans-serif;
  --radius-sm: calc(var(--radius) - 2px);
  --radius-md: var(--radius);
  --radius-lg: calc(var(--radius) + 2px);
  --breakpoint-desktop: 1280px;
  --breakpoint-wide: 2000px;
}

/* Maps Tailwind's dark: variant to any *-dark theme */
@custom-variant dark (&:where([data-theme$="-dark"], [data-theme$="-dark"] *));
```

**Adding a new theme**: create `[data-theme="<palette>-light"]` and `[data-theme="<palette>-dark"]` blocks in `globals.css`, then register both names in the `ThemeProvider` `themes` prop. No component changes are required.

---

## 3. Theme Strategy

- **Mechanism**: `data-theme="<name>"` attribute on `<html>` via next-themes with `attribute="data-theme"`
- **Initial themes**: `gray-light` (default), `gray-dark`
- **Naming convention**: `<palette>-<brightness>` -- palette name followed by `light` or `dark` suffix; future palettes follow the same pattern (e.g., `amber-light`, `amber-dark`)
- **Extensibility**: add a `[data-theme="<palette>-<brightness>"]` CSS block and register the name in `ThemeProvider`; no component changes needed
- **Priority**: `localStorage` preference, fallback to system `prefers-color-scheme`
- **Library**: next-themes (prevents SSR hydration mismatch)
- **Utility**: `src/lib/theme.ts` (typed theme names, ThemeProvider setup)
- **Toggle component**: `src/components/theme-toggle.tsx`
- **Tailwind**: the `dark:` utility variant maps to any `*-dark` theme via `@custom-variant dark`; avoid using `dark:` for values that differ per theme -- prefer CSS variable references so all themes benefit automatically

---

## 4. Responsive Strategy

The Figma design targets desktop security operations (complex dashboards, sidebar navigation). **Desktop is the primary target; mobile support is additive -- no horizontal scrolling on any viewport.**

### Desktop (>= 1280px)

- Minimum content width: 1280px; layout is optimized for this breakpoint
- Maximum content width: 2000px; horizontal margins expand beyond this
- Sidebar: 256px expanded (icon + label) / 64px collapsed (icon only + tooltip on hover); collapse state persisted in `localStorage`

### Mobile (< 1280px) -- layout reflow, no horizontal scroll

- Sidebar collapses into a slide-over Sheet (full-screen overlay)
- Hamburger button in a fixed top header replaces the sidebar
- Content area takes full width (single-column where applicable)
- Tables use horizontal scroll within their own container, not the page

---

## 5. Directory Structure

```
src/
+-- app/
|   +-- [locale]/
|   |   +-- (auth)/                # Auth route group
|   |   |   +-- sign-in/page.tsx
|   |   |   +-- reset-password/page.tsx
|   |   |   +-- layout.tsx         # Centered card layout
|   |   +-- (dashboard)/           # Authenticated route group
|   |   |   +-- home/page.tsx
|   |   |   +-- dashboard/page.tsx
|   |   |   +-- event/page.tsx
|   |   |   +-- detection/page.tsx
|   |   |   +-- triage/page.tsx
|   |   |   +-- report/page.tsx
|   |   |   +-- settings/
|   |   |   |   +-- accounts/page.tsx
|   |   |   |   +-- roles/page.tsx
|   |   |   |   +-- profile/page.tsx
|   |   |   +-- layout.tsx         # Dashboard layout with sidebar
|   |   +-- layout.tsx             # Locale layout: renders <html lang={locale}>, <body>, and i18n provider
|   +-- api/auth/                  # Auth Route Handlers
|   +-- globals.css                # Design tokens + Tailwind
|   +-- layout.tsx                 # Root layout: pass-through wrapper (returns children only, no <html>/<body>)
+-- components/
|   +-- ui/                        # shadcn/ui (auto-generated, do not edit manually)
|   |   +-- button.tsx, input.tsx, form.tsx, dialog.tsx
|   |   +-- sheet.tsx, table.tsx, badge.tsx, dropdown-menu.tsx
|   |   +-- avatar.tsx, checkbox.tsx, card.tsx, tooltip.tsx ...
|   +-- layout/
|   |   +-- sidebar.tsx
|   |   +-- sidebar-item.tsx
|   |   +-- breadcrumbs.tsx
|   |   +-- nav-user.tsx
|   |   +-- mobile-header.tsx
|   +-- auth/
|   |   +-- sign-in-form.tsx
|   |   +-- mfa-verification.tsx
|   |   +-- mfa-registration-wizard.tsx
|   |   +-- reset-password-form.tsx
|   +-- theme-toggle.tsx
+-- hooks/
|   +-- use-sidebar.ts
+-- lib/
    +-- theme.ts
    +-- utils.ts                   # shadcn/ui cn() helper
```

---

## 6. Layout Architecture

### Auth layout `(auth)/layout.tsx`

- Full-screen centered flex container
- Background: `var(--bg-canvas)` (`#f5f6f7` light / `#1a1d20` dark)
- Card: 432px fixed width, `var(--card-bg)` background, 6px radius, shadow

### Dashboard layout `(dashboard)/layout.tsx`

```
+--------------------+---------------------------+
|  Sidebar (256px)   |  MainContent              |
|  +---------------+ |  +---------------------+  |
|  | Logo          | |  | Breadcrumbs (64px)  |  |
|  |               | |  +---------------------+  |
|  | NavList       | |  |                     |  |
|  | (scrollable)  | |  |   Page Content      |  |
|  +---------------+ |  |                     |  |
|  | User Profile  | |  |                     |  |
|  | (pinned btm)  | |  |                     |  |
|  +---------------+ |  +---------------------+  |
+--------------------+---------------------------+
```

**Sidebar behavior**:

- Expanded (256px): icon + text label
- Collapsed (64px): icon only + tooltip on hover
- Mobile: Sheet slide-over (full overlay)
- Collapse state persisted in `localStorage`

**Admin submenu**: 181px floating panel, 4 items x 48px each

---

## 7. shadcn/ui Setup

### components.json

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",
    "baseColor": "gray",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

### Component install plan (phased)

Phase 1 -- Auth UI:

```bash
pnpm dlx shadcn@latest add button input form checkbox card label
```

Phase 2 -- Dashboard layout:

```bash
pnpm dlx shadcn@latest add sheet dropdown-menu avatar tooltip badge separator
```

Phase 3 -- Account management:

```bash
pnpm dlx shadcn@latest add table dialog alert-dialog select pagination
```

---

## 8. Page UI Requirements

Based on GitHub Discussion #32.

### Auth flow

- **Sign in**: Account ID field + Password field + show/hide toggle + Sign In button
- **MFA verification**: TOTP code input or WebAuthn prompt after ID/PW sign-in (shown when account has MFA registered)
- **MFA registration**: step-by-step wizard — method selection → QR code display (TOTP) or authenticator prompt (WebAuthn) → verification → recovery codes display (10 single-use codes, shown once). Triggered on first sign-in when `mfa_required` is effective (Discussion #32 §6.4)
- **Reset password**: new password + confirm password + password requirements checklist
- **Session timeout**: warning modal with countdown timer
- **Session ended**: signed-out screen

### Account management (Settings)

- **Accounts table**: name, role, status, last sign-in, row actions
- **Create/edit account**: dialog form
- **Role management**: permission matrix table
- **Custom role builder**: permission checkbox grid

### System settings

- Password policy form (minimum length, complexity rules, expiry)
- Session timeout configuration
- Account lockout policy
- MFA availability toggle

---

## 9. Internationalization

### Current state

- `src/i18n/messages/en.json` and `ko.json` exist but contain only one key
- `[locale]` route group exists but next-intl is NOT installed
- No `middleware.ts`, no routing config; root layout has hardcoded `lang="en"`

### Setup: next-intl with Next.js 16 App Router

Required files to create:

```
src/
+-- i18n/
|   +-- routing.ts      # defineRouting({ locales, defaultLocale, localePrefix })
|   +-- navigation.ts   # typed Link, redirect, useRouter
|   +-- request.ts      # getRequestConfig (server-side)
|   +-- messages/
|       +-- en.json
|       +-- ko.json
+-- middleware.ts        # locale detection + URL rewriting
```

`next.config.ts` must be wrapped with `createNextIntlPlugin`.

### URL strategy

Use `localePrefix: 'as-needed'` in `defineRouting`. The default locale gets no URL prefix; all other locales are prefixed. This must be set explicitly -- next-intl defaults to `'always'`, which would prefix every URL including the default locale.

**Configurable default locale via environment variable**, supporting different deployment targets without a code rebuild:

```typescript
// src/i18n/routing.ts
const defaultLocale = (process.env.DEFAULT_LOCALE ?? 'en') as 'en' | 'ko';

export const routing = defineRouting({
  locales: ['en', 'ko'],
  defaultLocale,
  localePrefix: 'as-needed',
});
```

Deployment scenarios:

| Deployment | DEFAULT_LOCALE | Result |
|------------|----------------|--------|
| Global | `en` (default if unset) | `/sign-in` = English, `/ko/sign-in` = Korean |
| Korean government | `ko` | `/sign-in` = Korean, `/en/sign-in` = English |

Set `DEFAULT_LOCALE` in `.env.local` (development), Docker environment variable, or Kubernetes secret. The value is read at server startup time -- changing it requires a container restart, not a code rebuild.

### Translation file structure

Organize by feature, not by page, to allow reuse across routes:

```json
{
  "common": {
    "signIn": "Sign In",
    "signOut": "Sign Out",
    "cancel": "Cancel",
    "save": "Save",
    "delete": "Delete",
    "confirm": "Confirm",
    "loading": "Loading...",
    "error": "An error occurred"
  },
  "auth": {
    "username": "Account ID",
    "password": "Password",
    "showPassword": "Show password",
    "signInHeading": "Sign into your account",
    "resetPassword": "Reset your password",
    "sessionTimeout": "Session timeout",
    "sessionEnded": "Session ended"
  },
  "nav": {
    "home": "Home",
    "dashboard": "Dashboard",
    "event": "Event",
    "detection": "Detection",
    "triage": "Triage",
    "report": "Report",
    "settings": "Settings"
  },
  "settings": {
    "accounts": "Accounts",
    "roles": "Roles",
    "profile": "Profile"
  },
  "validation": {
    "required": "{field} is required",
    "passwordMinLength": "Password must be at least {min} characters",
    "passwordMismatch": "Passwords do not match"
  }
}
```

### UI considerations for en/ko

- **Font**: Roboto covers Hangul in weights 400/500/700, but CJK rendering quality must be verified during implementation. If quality is insufficient, add `Noto Sans KR` as fallback: `font-family: 'Roboto', 'Noto Sans KR', sans-serif`. Make this decision after a rendering test -- do not add the fallback preemptively.
- **Text expansion**: Korean text length differs from English; use flexible widths and avoid fixed-width text containers.
- **Date/time**: use `next-intl`'s `useFormatter()` hook for locale-aware formatting (Korean: YYYY년 MM월 DD일).
- **Numbers**: use `useFormatter()` for byte counts, flow counts, etc.
- **Locale switcher**: place in the sidebar bottom section (near the user profile) or in profile settings; persist in `localStorage` and a cookie for SSR consistency.
- **`<html lang>`**: must be dynamic -- set from the locale parameter in the root layout, not hardcoded.

### shadcn/ui + i18n

shadcn/ui components are unstyled primitives with no built-in text strings. All visible text must use translation keys via `useTranslations` (Client Components) or `getTranslations` (Server Components).

AlertDialog, Dialog close buttons, and other interactive elements that render text must receive translated strings as props.

### Type-safe translations

Configure the next-intl TypeScript plugin for autocomplete and type checking of translation keys. Add to `tsconfig.json`:

```json
{
  "plugins": [
    { "name": "next" },
    { "name": "next-intl/plugin", "messageDir": "./src/i18n/messages" }
  ]
}
```

---

## 10. Accessibility

These requirements are mandatory for the initial release, not aspirational. Target: WCAG 2.1 Level AA.

- **Color contrast**: 4.5:1 minimum for normal text, 3:1 for large text and icons. Verify all theme token combinations (light, dark, primary button, disabled states).
- **Focus indicators**: visible 2px `--ring` outline on all interactive elements. Never use `outline: none` without a custom visible replacement.
- **Keyboard navigation**: all interactive elements must be reachable and operable by keyboard. Maintain logical tab order. Add a skip-to-content link on the dashboard layout.
- **Modal focus trap**: Dialog and AlertDialog must trap focus within the overlay. Esc closes the modal. Focus returns to the trigger element on close.
- **Tooltip accessibility**: `role="tooltip"` + `aria-describedby` on the trigger element. Tooltips must be keyboard-accessible, not hover-only.
- **Form errors**: `aria-invalid="true"` + `aria-describedby` pointing to the error message element. Never rely on color alone to communicate errors.
- **ARIA landmarks**: use `<main>`, `<nav>`, and `<aside>` (for the sidebar) on the dashboard layout.
- **Semantic HTML**: use semantic elements (`<button>` for actions, `<a>` for navigation); avoid div-soup.

---

## 11. Out of Scope

The following are explicitly excluded from this document:

- API contracts, GraphQL schema, BFF endpoint design (see `ARCHITECTURE.md`)
- Authorization and permission policy details, including permission-based conditional rendering strategy (see Discussion #32; frontend implementation will be defined alongside the data layer architecture)
- Performance budgets and Core Web Vitals targets
- CI/CD pipeline configuration
- Detailed component implementation (written during feature work, not here)

---

## 12. Additional Packages

```bash
# i18n
pnpm add next-intl

# Theme management (SSR-safe)
pnpm add next-themes

# Animation (replaces deprecated tailwindcss-animate)
pnpm add tw-animate-css

# Icons
pnpm add lucide-react

# Forms + validation (Issue #1 confirmed)
pnpm add react-hook-form zod @hookform/resolvers

# Server state management (Issue #1 confirmed)
pnpm add @tanstack/react-query
```


