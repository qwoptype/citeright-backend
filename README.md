# CiteRight backend

This is the API expected by `CiteRightV0.2.html`.

## Routes
- `GET /api/healthz` returns `{"status":"ok"}`.
- `POST /api/metadata` accepts `{"url":"https://example.com/article"}` and returns `title`, `authors` (array), `publishedDate`, `siteName`, `canonicalUrl`, and `missingFields`.

## Deploy on Render using the browser
1. Create a new public GitHub repository, e.g. `citeright-backend`.
2. Upload these files to the repository root (`server.js`, `package.json`, `render.yaml`, and this README).
3. In Render, choose **New + → Web Service**, connect the repository, and deploy. If prompted for settings, use:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free (if available for your account)
4. Once deployed, copy the service's HTTPS URL, e.g. `https://citeright-api-xxxx.onrender.com`.
5. In Render's Environment settings, add `FRONTEND_ORIGIN` with the exact origin of your hosted CiteRight page, with no path or trailing slash. Example: `https://your-citeright-site.netlify.app`. Save and redeploy if prompted.
6. Open the API URL plus `/api/healthz` in a browser. It should show `{"status":"ok"}`.
7. In CiteRight → Connection settings, enter only the base API URL (not `/api`) and press **Test connection**.

If you have not hosted CiteRight yet, deploy the HTML first. Use the origin shown in the browser address bar, such as `https://your-site.netlify.app`, as `FRONTEND_ORIGIN`.

## Notes and limitations
- `FRONTEND_ORIGIN` must exactly match the CiteRight page origin. Multiple origins can be separated by commas.
- This backend is a starter implementation. It blocks local/private IP targets and limits response size and redirects, but no public URL-fetching service is risk-free. Review and add rate limiting/authentication before sharing widely.
- Some publishers block bots or hide metadata; lookup is best-effort. It supports common HTML metadata and attempts Crossref lookup when a DOI is found.
- PDFs are not parsed by this endpoint. Use the article landing page or enter details manually.
- The free hosting tier may sleep when idle, so the first request can take a little longer.
