import { route } from '../../../../lib/vercel.js';

export default function handler(req, res) {
  const id = encodeURIComponent(req.query.id);
  const tid = String(req.query.tid);
  // Keep the function count under the Hobby limit: /tests/bulk is served by
  // this route and dispatched as the bulk endpoint.
  const suffix = tid === 'bulk' ? 'tests/bulk' : `tests/${encodeURIComponent(tid)}`;
  return route(req, res, `/api/problems/${id}/${suffix}`);
}
