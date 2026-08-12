# CourseForge Web

## API connection

The Alpha UI uses the same-origin `/api` proxy by default. Override
`NEXT_PUBLIC_COURSEFORGE_API_BASE_URL` only for a reviewed development setup.
The server-side proxy target is `COURSEFORGE_INTERNAL_API_URL` (default
`http://127.0.0.1:3001`). Neither value may contain credentials.

If the API cannot be reached, the UI shows a connection screen. A user may
explicitly choose isolated demo mode; the application never silently substitutes
demo data for a failed API call.

Same-origin proxying keeps the HttpOnly session cookie on one browser origin.
Production still requires HTTPS and `SECURE_COOKIES=true` at the API.

## Reveal runtime and preview isolation

`reveal.js` is pinned exactly in this workspace. `prebuild` copies the required
CSS, theme, JavaScript, notes plugin, and CourseForge bootstrap into `public/`;
`postbuild` also places them in the Next standalone tree. No CDN or external
font is used.

Online WebPPT previews navigate the iframe directly to the authenticated
same-origin `/api` artifact URL. The iframe grants `allow-scripts` so Reveal can
change slides, but deliberately omits `allow-same-origin`, popup, form, download,
and top-navigation capabilities. Public Reveal assets therefore need no session
cookie, while the HTML navigation remains protected by the API session.

## Checks

```sh
npm run typecheck --workspace @courseforge/web
npm test --workspace @courseforge/web
npm run build --workspace @courseforge/web
```
